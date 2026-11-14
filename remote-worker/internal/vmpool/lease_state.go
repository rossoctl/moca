package vmpool

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// leaseStateDir holds one state file per workspace_key under WorkspaceRoot. It starts
// with a dot, and validKey requires an alphanumeric first character, so no key can
// resolve to it -- the same argument tombstonePrefix makes.
const leaseStateDir = ".lease-state"

// leaseState is a key's mode, epoch and lease bookkeeping, persisted next to the
// workspace so it survives a worker restart (spec §8.2). Known is false when there was
// no readable file: the key then runs per-Exec until SetMode restores its mode.
type leaseState struct {
	Mode      Mode        `json:"mode"`
	Epoch     uint64      `json:"epoch"`
	Known     bool        `json:"known"`
	RootWrote bool        `json:"root_wrote"`        // a per-Exec command ran as root since the last lease (spec §4)
	Open      *openLease  `json:"open,omitempty"`    // the lease live when the file was written
	Pending   *LeaseEvent `json:"pending,omitempty"` // the unacknowledged start or end
}

// openLease is the lease a state file says is live. A file found with Open set at
// startup belongs to a lease the previous process never ended (Task 5).
type openLease struct {
	VMID    string    `json:"vm_id"`
	Mode    Mode      `json:"mode"`
	Started time.Time `json:"started"`
}

func leaseStatePath(root, key string) string {
	return filepath.Join(root, leaseStateDir, key+".json")
}

// loadLeaseState reads key's state. Missing, unreadable and malformed all give
// leaseState{Known: false} -- fail closed (spec §8.2) -- with one log line saying which.
func loadLeaseState(root, key string) leaseState {
	if err := checkKey(key); err != nil {
		log.Printf("vmpool: lease state: %v; epoch unknown", err)
		return leaseState{}
	}
	path := leaseStatePath(root, key)
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			log.Printf("vmpool: lease state for %q: none at %s; epoch unknown, mode per-exec until set_mode", key, path)
		} else {
			log.Printf("vmpool: lease state for %q: %v; epoch unknown, mode per-exec until set_mode", key, err)
		}
		return leaseState{}
	}
	var s leaseState
	if err := json.Unmarshal(b, &s); err != nil {
		log.Printf("vmpool: lease state for %q: %s is malformed (%v); epoch unknown, mode per-exec until set_mode",
			key, path, err)
		return leaseState{}
	}
	return s
}

// saveLeaseState writes key's state atomically and durably (writeDurably). A crash leaves
// the old file or the new one, never a torn one -- and a torn one would read as unknown,
// which is safe but loses a restored mode.
func saveLeaseState(root, key string, s leaseState) error {
	if err := checkKey(key); err != nil {
		return err
	}
	b, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("lease state for %q: %w", key, err)
	}
	if err := writeDurably(filepath.Join(root, leaseStateDir), key+".json", b); err != nil {
		return fmt.Errorf("lease state for %q: %w", key, err)
	}
	return nil
}

// writeDurably replaces dir/name with b: a temp file in dir, fsync, rename over the old
// file, fsync the directory. The temp file's name starts with a dot and does not end in
// .json, so nothing that lists the state files takes it for one.
func writeDurably(dir, name string, b []byte) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("dir: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "."+name+".tmp-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }() // a no-op once the rename succeeded
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("fsync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	if err := os.Rename(tmp.Name(), filepath.Join(dir, name)); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("dir: %w", err)
	}
	defer func() { _ = d.Close() }()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("dir: fsync: %w", err)
	}
	return nil
}

// loadLeaseStateIfAny is loadLeaseState for a caller that may look at a key with no
// file: a missing file is unknown, with no log line. Callers that only read (status, an
// acknowledgement) must not log once per call for every per-Exec key.
func loadLeaseStateIfAny(root, key string) leaseState {
	if _, err := os.Stat(leaseStatePath(root, key)); errors.Is(err, os.ErrNotExist) {
		return leaseState{}
	}
	return loadLeaseState(root, key)
}

// retireLeaseState is what removing key's workspace does to its state file (PR #763
// review). The mode, the epoch and Known are the control plane's, not the tree's, so they
// stay: a lease sandbox whose workspace was reclaimed while idle is still one, and epochs
// only go up, so keeping them cannot weaken stale-mode. RootWrote is set, since the new
// tree's history is unknown (ruling R7), and Open is cleared: a run with a live lease is
// busy and never has its workspace removed. A pending event stays (ruling R9: spec §5
// keeps the last end event until a client has seen it). With nothing worth keeping -- no
// known epoch and nothing pending -- the file is deleted.
//
// A file that is already gone stays gone: s is the run's cached copy, and the worker's own
// removals update that cache, so a missing file was removed by the host's janitor
// (deploy/sbx/janitor.sh) for a deleted sandbox. Writing the cache back would leave a file
// no sandbox owns. The janitor removes it only SBX_JANITOR_AGE after the termination, and
// deploy/sbx/setup.sh refuses, when a lease mode is allowed, a wait that does not exceed
// the token lifetime plus the relay's 30 s leeway plus SBX_IDLE_CEILING_S (at most
// 86400 s): a token minted just before the delete reaches the sandbox that long, and each
// of its Execs restarts the idle clock, so the sandbox's last lease ends before the
// janitor's wait does. So no lease of that key is live to need the file. Should one be
// (a hand-set wait), endLeaseLocked applies the same check and does not write the file
// back either. The stat below and the save are not atomic against the janitor's removal;
// losing that race leaves one small file, which the janitor's next run removes (the
// workspace is gone and the record terminated).
func retireLeaseState(root, key string, s leaseState) {
	if !s.Known && s.Pending == nil {
		removeLeaseState(root, key)
		return
	}
	if leaseStateFileGone(root, key) {
		return
	}
	kept := leaseState{Pending: s.Pending}
	if s.Known {
		kept.Mode, kept.Epoch, kept.Known, kept.RootWrote = s.Mode, s.Epoch, true, true
	}
	if err := saveLeaseState(root, key, kept); err != nil {
		log.Printf("vmpool: retire the lease state for %q: %v", key, err)
	}
}

// leaseStateFileGone reports that key's state file does not exist. For a run whose cached
// state is known, that means the host's janitor removed it for a deleted sandbox: the
// worker's own removals update the cache (retireLeaseState, endLeaseLocked).
func leaseStateFileGone(root, key string) bool {
	_, err := os.Stat(leaseStatePath(root, key))
	return errors.Is(err, os.ErrNotExist)
}

// removeLeaseState deletes key's state file. A missing file is not an error; any other
// failure is logged, because the caller is removing the workspace and has nothing to do
// with an error but report it.
func removeLeaseState(root, key string) {
	if checkKey(key) != nil {
		return
	}
	if err := os.Remove(leaseStatePath(root, key)); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("vmpool: remove lease state for %q: %v", key, err)
	}
}

// leaseBootMarker is the file New writes at every boot, under leaseStateDir: lease=on or
// lease=off. It cannot be read as a key's state: it does not end in .json, and checkKey
// refuses a leading dot.
const leaseBootMarker = ".boot"

// markLeaseBoot records whether this boot serves lease mode, and when it does and the
// last boot did not -- the marker says lease=off, or is missing or unreadable -- sets
// root_wrote on every known state first (PR #763 carry-over). A lease-off worker runs
// per-Exec commands as root without recording root_wrote (perExecUnderGate is the
// lease-enabled pool's), so a known state's root_wrote = false is no longer evidence that
// root has not written the tree since its last lease: the first lease must normalise it
// (ruling R7). With no marker and no state files there is nothing to mark.
//
// The states are marked before the marker is written, so a crash in between marks them
// again at the next boot, which changes nothing. Any failure fails New: a lost root_wrote
// would let a lease skip normalising a tree root has written, and a lease-off boot whose
// lease=off cannot be written would leave lease=on for the next lease-on boot to trust.
func markLeaseBoot(root string, leaseOn bool) error {
	dir := filepath.Join(root, leaseStateDir)
	marker := "lease=off"
	if leaseOn {
		marker = "lease=on"
		prev, err := os.ReadFile(filepath.Join(dir, leaseBootMarker))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("vmpool: lease boot marker: %v; taken as a lease-off boot", err)
		}
		if err != nil || strings.TrimSpace(string(prev)) != marker {
			if err := markRootWroteAll(root); err != nil {
				return err
			}
		}
	}
	if err := writeDurably(dir, leaseBootMarker, []byte(marker+"\n")); err != nil {
		return fmt.Errorf("vmpool: lease boot marker: %w", err)
	}
	return nil
}

// markRootWroteAll sets and saves root_wrote on every known state file under root.
func markRootWroteAll(root string) error {
	ents, err := os.ReadDir(filepath.Join(root, leaseStateDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("vmpool: lease state dir: %w", err)
	}
	n := 0
	for _, ent := range ents {
		key, ok := strings.CutSuffix(ent.Name(), ".json")
		if !ok || ent.IsDir() || checkKey(key) != nil {
			continue
		}
		s := loadLeaseState(root, key)
		if !s.Known || s.RootWrote {
			continue
		}
		s.RootWrote = true
		if err := saveLeaseState(root, key, s); err != nil {
			return fmt.Errorf("vmpool: record root_wrote after a lease-off or unrecorded boot: %w", err)
		}
		n++
	}
	if n > 0 {
		log.Printf("vmpool: lease on after a lease-off or unrecorded boot: root_wrote set on %d known states; their next lease normalises", n)
	}
	return nil
}
