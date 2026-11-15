package vmpool

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Files a snapshot directory must contain. vmstate and memfile are what the VMM
// loads; kernel, rootfs and agent are kept alongside so the hash covers what actually
// determines guest behaviour rather than only the serialized state.
const (
	fileVMState  = "vmstate"
	fileMemory   = "memfile"
	fileKernel   = "kernel"
	fileRootfs   = "rootfs"
	fileAgent    = "agent"
	fileManifest = "manifest.json"
)

// Manifest pins one golden snapshot.
//
// InstanceType is not decoration: restore requires IDENTICAL hardware and software
// (spec §2.4), so the snapshot is instance-generation-specific and must be built on
// the type that will run it. Recording it is also spec §6's "record the substrate in
// every run record" at the artifact level — a nested-vs-metal divergence is
// undiagnosable without it.
//
// Two hash versions. Version 1 (HashVersion absent) hashes kernel + rootfs + agent only
// (spec §5.5), so every other field, and vmstate and memfile, could be edited without
// the hash noticing. Version 2 hashes every field and every file, so Hash identifies
// the whole build and can serve as its build id. A version-1 manifest still verifies
// under its own rule: snapshots built before version 2 keep working until they are
// rebuilt.
type Manifest struct {
	HashVersion  int       `json:"hash_version,omitempty"`
	Image        string    `json:"image"`
	VMM          string    `json:"vmm"`
	InstanceType string    `json:"instance_type"`
	Kernel       string    `json:"kernel_release"`
	GuestRAMMB   int64     `json:"guest_ram_mb"`
	VCPUs        int       `json:"vcpus,omitempty"`
	Capabilities []string  `json:"capabilities"`
	BuiltAt      time.Time `json:"built_at"`

	KernelSHA256 string `json:"kernel_sha256"`
	RootfsSHA256 string `json:"rootfs_sha256"`
	AgentSHA256  string `json:"agent_sha256"`
	// Version 2 only. vmstate is small and is checked at every start; memfile is the
	// guest's whole RAM (several GiB for a typical template), so the worker re-reads it
	// only when asked (VerifyOptions.Memfile).
	VMStateSHA256 string `json:"vmstate_sha256,omitempty"`
	MemfileSHA256 string `json:"memfile_sha256,omitempty"`
	// cloud-hypervisor's snapshot config (ch-config.json), which restore replays; empty
	// for Firecracker. Version 2 only.
	CHConfigSHA256 string `json:"ch_config_sha256,omitempty"`
	// The sha256 of the egress CA's DER, when the rootfs trusts one. Outside the hash in
	// version 1; inside it in version 2.
	EgressCASHA256 string `json:"egress_ca_sha256,omitempty"`
	// The image digest build-rootfs.sh recorded in the rootfs's /etc/moca-rootfs-source,
	// copied here so a template record's image can be checked against it without mounting
	// the rootfs. Version 2 only; empty for a rootfs built some other way.
	SourceImageDigest string `json:"source_image_digest,omitempty"`
	// Hash: see HashVersion. Version 1 does NOT cover vmstate or memfile: they change on
	// every rebuild even when nothing behavioural did. Version 2 does, because it names
	// one build, not one toolchain.
	Hash string `json:"hash"`

	// Features names what the guest image supports beyond per-Exec, e.g. lease-v1.
	// It is outside Hash in both versions (version 2's line set does not name it), so a
	// snapshot built before the field existed still verifies; it simply advertises nothing.
	Features []string `json:"features,omitempty"`
}

// FeatureLeaseV1 marks an image built for lease mode: cgroup2 mounted, user
// namespaces disabled, the sbx exec identity present and no setuid binaries
// (deploy/microvm/build-snapshot.sh). A worker refuses lease mode without it.
const FeatureLeaseV1 = "lease-v1"

// FeatureLeaseProcessesV1 marks an image built for lease level 2, tracked processes:
// the sbxp<n> identities (uids 20000..20003, group sbx-ws, HOME /tmp/sbx-proc/<uid>) and
// an agent started with that tracked uid range, with cgroup.kill proved in the guest
// (deploy/microvm/build-snapshot.sh). Firecracker builds only, always beside lease-v1. A
// worker refuses a process kind (process_start, list, logs, stop) without it.
const FeatureLeaseProcessesV1 = "lease-processes-v1"

// FeatureBalloonFPRV1 marks a snapshot whose VM carries a virtio-balloon in free-page
// reporting mode only (amount 0, never inflated): the guest returns the pages it frees, so
// an idle lease's measured charge follows its working set rather than its peak (spec §6).
// Firecracker builds only; a restored VM keeps reporting. Lease mode works without it.
const FeatureBalloonFPRV1 = "balloon-fpr-v1"

// HasFeature reports whether the snapshot advertises f.
func (m Manifest) HasFeature(f string) bool {
	return slices.Contains(m.Features, f)
}

// HashVersionAll is the manifest hash that covers every field and file.
const HashVersionAll = 2

// fileCHConfig is cloud-hypervisor's snapshot config, kept beside vmstate and memfile.
const fileCHConfig = "ch-config.json"

// VerifyOptions widens Verify. The zero value is what a worker checks at every start.
type VerifyOptions struct {
	// Memfile re-hashes the memory file too (version 2): a full read of the guest's RAM
	// image, seconds per GiB, so off by default (SH_VERIFY_MEMFILE=1 turns it on).
	Memfile bool
	// Cache, if set, is the path of a verify cache file (verifycache.go): a file whose
	// identity is unchanged since a full hash on this host matched the manifest is not
	// hashed again. Empty: every file is hashed in full, every time. The comparison against
	// the manifest is made either way, and a bad cache only costs a full hash.
	Cache string
	// Settle, with Cache: a file changed too recently to be recorded safely (within the
	// cache's racy window, ~2 s) is waited out before it is hashed, instead of being hashed
	// and left unrecorded. For the build-time seed, which runs moments after the build
	// last touched the files; a worker start never waits.
	Settle bool
	// Logf reports a cache that was ignored or not written, and how many files the cache
	// spared. nil: log.Printf.
	Logf func(format string, args ...any)
}

// Fill computes the component digests and Hash from the files in dir, as version 2.
func (m *Manifest) Fill(dir string) error {
	var err error
	for _, c := range []struct {
		name string
		dst  *string
	}{
		{fileKernel, &m.KernelSHA256},
		{fileRootfs, &m.RootfsSHA256},
		{fileAgent, &m.AgentSHA256},
		{fileVMState, &m.VMStateSHA256},
		{fileMemory, &m.MemfileSHA256},
	} {
		if *c.dst, err = fileSHA256(filepath.Join(dir, c.name)); err != nil {
			return err
		}
	}
	if _, statErr := os.Stat(filepath.Join(dir, fileCHConfig)); statErr == nil {
		if m.CHConfigSHA256, err = fileSHA256(filepath.Join(dir, fileCHConfig)); err != nil {
			return err
		}
	}
	if m.BuiltAt.IsZero() {
		m.BuiltAt = time.Now().UTC()
	}
	sort.Strings(m.Capabilities)
	m.HashVersion = HashVersionAll
	if m.Hash, err = m.ComputeHash(); err != nil {
		return err
	}
	return nil
}

// ComputeHash is the manifest's hash under its own HashVersion.
//
// Version 2 hashes one "name:value" line per field, in this fixed order, after a header
// line naming the version. build-snapshot.sh's write_manifest prints the same lines, and
// its test pins them, so the two must change together. built_at is hashed as RFC 3339 in
// UTC, whole seconds (what the script writes); capabilities sorted and comma-joined. A
// value holding a newline could forge a line, so it is refused rather than hashed.
func (m Manifest) ComputeHash() (string, error) {
	h := sha256.New()
	switch m.HashVersion {
	case 0, 1:
		fmt.Fprintf(h, "kernel:%s\nrootfs:%s\nagent:%s\n", m.KernelSHA256, m.RootfsSHA256, m.AgentSHA256)
	case HashVersionAll:
		caps := append([]string(nil), m.Capabilities...)
		sort.Strings(caps)
		lines := [][2]string{
			{"image", m.Image},
			{"vmm", m.VMM},
			{"instance_type", m.InstanceType},
			{"kernel_release", m.Kernel},
			{"guest_ram_mb", strconv.FormatInt(m.GuestRAMMB, 10)},
			{"vcpus", strconv.Itoa(m.VCPUs)},
			{"capabilities", strings.Join(caps, ",")},
			{"built_at", m.BuiltAt.UTC().Format(time.RFC3339)},
			{"kernel", m.KernelSHA256},
			{"rootfs", m.RootfsSHA256},
			{"agent", m.AgentSHA256},
			{"vmstate", m.VMStateSHA256},
			{"memfile", m.MemfileSHA256},
			{"ch_config", m.CHConfigSHA256},
			{"egress_ca", m.EgressCASHA256},
			{"source_image_digest", m.SourceImageDigest},
		}
		fmt.Fprintf(h, "moca-snapshot-manifest/%d\n", HashVersionAll)
		for _, l := range lines {
			if strings.ContainsAny(l[1], "\n\r") {
				return "", fmt.Errorf("manifest field %s holds a line break; refusing to hash it", l[0])
			}
			fmt.Fprintf(h, "%s:%s\n", l[0], l[1])
		}
	default:
		return "", fmt.Errorf("manifest hash_version %d is not one this worker knows (1 or %d): "+
			"a newer build-snapshot.sh wrote it", m.HashVersion, HashVersionAll)
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), nil
}

func LoadManifest(dir string) (Manifest, error) {
	b, err := os.ReadFile(filepath.Join(dir, fileManifest))
	if err != nil {
		return Manifest{}, fmt.Errorf("snapshot %s: %w", dir, err)
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return Manifest{}, fmt.Errorf("snapshot %s: manifest: %w", dir, err)
	}
	return m, nil
}

// Verify re-hashes the components on disk and compares against the manifest, with the
// checks a worker makes at every start (VerifyWith's zero options).
//
// LOUDLY, and naming the component that drifted. Spec §5.5's failure mode is a stale
// snapshot silently serving an old toolchain — which surfaces as a workload failing
// for reasons nothing in the run record explains. Because only a 64-bit CRC guards the
// state file and the VMM trusts these files (spec §2.4), this check is the trust
// boundary and it deliberately runs OUTSIDE the VMM.
func (m Manifest) Verify(dir string) error { return m.VerifyWith(dir, VerifyOptions{}) }

// VerifyWith is Verify with the memory file optionally re-hashed too.
func (m Manifest) VerifyWith(dir string, o VerifyOptions) error {
	for _, f := range []string{fileVMState, fileMemory, fileKernel, fileRootfs, fileAgent} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			return fmt.Errorf("snapshot %s: %s: %w", dir, f, err)
		}
	}
	checks := []struct {
		name string
		want string
	}{
		{fileKernel, m.KernelSHA256},
		{fileRootfs, m.RootfsSHA256},
		{fileAgent, m.AgentSHA256},
	}
	if m.HashVersion == HashVersionAll {
		checks = append(checks, struct{ name, want string }{fileVMState, m.VMStateSHA256})
		if o.Memfile {
			checks = append(checks, struct{ name, want string }{fileMemory, m.MemfileSHA256})
		}
		if m.CHConfigSHA256 != "" {
			checks = append(checks, struct{ name, want string }{fileCHConfig, m.CHConfigSHA256})
		}
	}
	var cache *verifyCache
	keyDir := dir
	if o.Cache != "" {
		logf := o.Logf
		if logf == nil {
			logf = log.Printf
		}
		cache = openVerifyCache(o.Cache, logf)
		cache.settle = o.Settle
		defer cache.save() // also after a failure: a drifted file's entry is dropped
		// Entries are keyed by the canonical absolute path, so a worker and the build-time
		// seed (microvm-worker -verify-snapshot) agree however each spells the directory.
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			keyDir = real
		}
		if abs, err := filepath.Abs(keyDir); err == nil {
			keyDir = abs
		}
	}
	cachedN := 0
	for _, c := range checks {
		var got string
		var err error
		if cache != nil {
			var hit bool
			got, hit, err = cache.check(filepath.Join(keyDir, c.name), c.want)
			if hit {
				cachedN++
			}
		} else {
			got, err = verifyHashFile(filepath.Join(dir, c.name))
		}
		if err != nil {
			return err
		}
		if got != c.want {
			return fmt.Errorf("snapshot %s: %s drifted: manifest says %s, on disk %s — "+
				"rebuild the snapshot rather than running an old toolchain (spec §5.5)", dir, c.name, c.want, got)
		}
	}
	if cache != nil {
		cache.logf("vmpool: verify cache %s: %d of %d snapshot files unchanged since a full check on this host, %d hashed in full",
			o.Cache, cachedN, len(checks), len(checks)-cachedN)
	}
	got, err := m.ComputeHash()
	if err != nil {
		return fmt.Errorf("snapshot %s: %w", dir, err)
	}
	if got != m.Hash {
		return fmt.Errorf("snapshot %s: manifest hash %s does not match its own fields and components (%s)", dir, m.Hash, got)
	}
	return nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), nil
}

// probeKey is reserved and can never collide with a wire-supplied workspace_key:
// checkKey requires the first character to be alphanumeric.
const probeKey = "_probe"

// probeCommandTimeoutS is the guest-side bound on the probe's `true`, and probeTimeout
// is the HOST-side bound on the whole probe. Two numbers because they bound two
// different things: the first is a field in a frame the guest reads, the second is the
// only thing that holds if the guest never reads anything. probeTimeout must therefore
// exceed probeCommandTimeoutS with room for a cold restore and a resume, or a wedged
// guest would be reported as a host-side deadline rather than as the timeout it is.
const (
	probeCommandTimeoutS uint32 = 30
	probeTimeout                = 90 * time.Second
)

// Probe restores one VM, runs a trivial command in it and destroys it.
//
// Spec §6's last row: the pinned hash is not sufficient, because a snapshot can be
// intact and still unrestorable on this host — wrong instance generation, cgroups v1,
// no /dev/kvm, a jailer misconfiguration. So the unit fails at START rather than on a
// user's first request. It bypasses checkKey deliberately, using a reserved key that
// no wire value can spell.
func (p *pool) Probe(ctx context.Context) error {
	// A DEADLINE OF ITS OWN. Probe's whole reason for existing is to fail the unit at
	// START rather than on a user's first request, and its caller
	// (cmd/microvm-worker/main.go) passes context.Background(). The Command below
	// carries a timeout_s, but that field only arms the GUEST's timer — a guest that
	// accepts the vsock connection and then never answers, or a VMM that never
	// finishes restoring, would hang worker startup forever, which is the exact
	// opposite of what this function is for.
	//
	// Armed off p.clk, not context.WithTimeout, for the same reason everything else
	// in this package takes a Clock: a test must be able to drive this expiry.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	tm := p.clk.AfterFunc(probeTimeout, cancel)
	defer tm.Stop()

	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return ErrClosed
	}
	dir := filepath.Join(p.cfg.WorkspaceRoot, probeKey)
	id := p.nextIDLocked()
	p.mu.Unlock()

	vm, err := p.warm(ctx, probeKey, dir, id)
	if err != nil {
		return fmt.Errorf("startup probe: could not restore a VM: %w", err)
	}
	defer func() {
		if err := vm.Destroy(); err != nil {
			p.counters.destroyFailed()
		}
		_ = removeWorkspace(dir)
	}()
	if err := vm.Resume(ctx); err != nil {
		return fmt.Errorf("startup probe: could not resume: %w", err)
	}
	res, err := vm.Run(ctx, Command{Command: "true", TimeoutS: probeCommandTimeoutS, CapBytes: OutputCapBytes}, discardingSink{})
	if err != nil {
		return fmt.Errorf("startup probe: guest did not answer: %w", err)
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("startup probe: `true` exited %d in the guest", res.ExitCode)
	}
	return nil
}

type discardingSink struct{}

func (discardingSink) Stdout([]byte) {}
func (discardingSink) Stderr([]byte) {}
