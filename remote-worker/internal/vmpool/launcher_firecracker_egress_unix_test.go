//go:build unix

package vmpool

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/rossoctl/moca/remote-worker/internal/egress/control"
	"github.com/rossoctl/moca/remote-worker/internal/shortdir"
)

// recordingBinder is an EgressBinder that logs its calls in order and runs optional hooks
// at the moment of each call.
type recordingBinder struct {
	mu            sync.Mutex
	events        []string
	registerErr   error
	unregisterErr error
	onRegister    func()
	onUnregister  func()
	registeredSID string
	// registerCtxErr and registerHasDL capture the ctx Register saw, after onRegister ran.
	registerCtxErr error
	registerHasDL  bool
}

func (b *recordingBinder) Register(ctx context.Context, vmID, sid string, grant []byte, ln *os.File) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, "register:"+vmID)
	b.registeredSID = sid
	if ln == nil {
		return errors.New("nil listener file")
	}
	if b.onRegister != nil {
		b.onRegister()
	}
	b.registerCtxErr = ctx.Err()
	_, b.registerHasDL = ctx.Deadline()
	return b.registerErr
}

func (b *recordingBinder) Unregister(_ context.Context, vmID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, "unregister:"+vmID)
	if b.onUnregister != nil {
		b.onUnregister()
	}
	return b.unregisterErr
}

func (b *recordingBinder) log() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.events...)
}

// egressLauncher builds a launcher whose fake jailer records whether the egress socket
// existed at the moment it ran. The jail layout is <base>/firecracker/<id>/root, and the
// jailer's argv is "--id <id> ...", so the script derives the jail from $2.
func egressLauncher(t *testing.T, b EgressBinder) (Launcher, string, string) {
	t.Helper()
	base := shortdir.New(t, "fceg", len("/firecracker/vm-6/root/run/firecracker.socket"))
	marker := filepath.Join(base, "jailer-marker")
	jailer := filepath.Join(base, "jailer")
	script := "#!/bin/sh\njail=" + base + "/firecracker/$2/root\n" +
		"if [ -S \"$jail/run/v.sock_1025\" ]; then echo yes >" + marker + "; else echo no >" + marker + "; fi\nexit 0\n"
	if err := os.WriteFile(jailer, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	opts := FirecrackerOptions{
		JailerBin: jailer, FirecrackerBin: filepath.Join(base, "firecracker"),
		ChrootBase: base, SnapshotDir: base,
		UID: os.Getuid(), GID: os.Getgid(),
	}
	if b != nil {
		opts.Egress = b
	}
	lc, err := NewFirecrackerLauncher(opts)
	if err != nil {
		t.Fatalf("NewFirecrackerLauncher: %v", err)
	}
	return lc, base, marker
}

func egressSock(base, id string) string {
	return filepath.Join(base, "firecracker", id, "root", "run", "v.sock_1025")
}

// seedSnapshot creates the files Restore hardlinks, so a restore gets past that step.
func seedSnapshot(t *testing.T, base string) {
	t.Helper()
	for _, n := range []string{fileVMState, fileMemory, fileKernel, fileRootfs, fileAgent} {
		if err := os.WriteFile(filepath.Join(base, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// A workspace image that already looks formatted, so Restore does not shell out to mkfs.
	img := make([]byte, ext4MagicOffset+2)
	img[ext4MagicOffset], img[ext4MagicOffset+1] = byte(ext4Magic&0xff), byte(ext4Magic>>8)
	if err := os.WriteFile(filepath.Join(base, "workspace.img"), img, 0o644); err != nil {
		t.Fatal(err)
	}
}

func restoreShort(lc Launcher, base, id string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	_, err := lc.Restore(ctx, RestoreRequest{ID: id, Key: "sess-1", WorkspaceDir: base, GuestRAMBytes: 256 << 20})
	return err
}

func TestGateEgressStandbyFailsClosed(t *testing.T) {
	b := &recordingBinder{registerErr: errors.New("refused")}
	lc, base, marker := egressLauncher(t, b)
	seedSnapshot(t, base)

	_, err := lc.Restore(context.Background(), RestoreRequest{ID: "vm-1", Key: "sess-1", WorkspaceDir: base, GuestRAMBytes: 256 << 20})
	if err == nil || !strings.Contains(err.Error(), "egress") {
		t.Fatalf("Restore err = %v, want one naming egress", err)
	}
	if _, statErr := os.Stat(marker); statErr == nil {
		t.Error("the jailer ran although Register failed: the VM would have been a standby without egress")
	}
	if _, statErr := os.Lstat(egressSock(base, "vm-1")); !os.IsNotExist(statErr) {
		t.Errorf("egress socket survived a failed restore: %v", statErr)
	}
}

func TestEgressSocketIsBoundBeforeTheJailerStarts(t *testing.T) {
	b := &recordingBinder{}
	lc, base, marker := egressLauncher(t, b)
	seedSnapshot(t, base)
	b.onRegister = func() {
		if _, err := os.Stat(marker); err == nil {
			t.Error("the jailer had already run when Register was called")
		}
		if c, err := net.Dial("unix", egressSock(base, "vm-2")); err != nil {
			t.Errorf("socket not accepting connections at Register time: %v", err)
		} else {
			_ = c.Close()
		}
	}
	_ = restoreShort(lc, base, "vm-2") // fails at the API socket wait; the fake jailer never creates one
	got, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("jailer never ran: %v", err)
	}
	if strings.TrimSpace(string(got)) != "yes" {
		t.Fatalf("jailer saw the egress socket as %q, want yes", got)
	}
	// Restore fails after Register succeeded, so cleanup must hand the VM back exactly once and
	// then unlink the socket.
	if ev, want := b.log(), []string{"register:vm-2", "unregister:vm-2"}; strings.Join(ev, ",") != strings.Join(want, ",") {
		t.Fatalf("events = %v, want %v", ev, want)
	}
	if _, statErr := os.Lstat(egressSock(base, "vm-2")); !os.IsNotExist(statErr) {
		t.Errorf("egress socket survived the failed restore: %v", statErr)
	}
	if b.registeredSID != "sess-1" {
		t.Errorf("registered session %q, want the RestoreRequest key", b.registeredSID)
	}
}

// A cold acquire restores under the Exec request's own ctx. Cancelling it must not reach the
// control call, or one aborted Exec would cost the shared control connection (I1).
func TestEgressRegisterIsDetachedFromTheCallersCancel(t *testing.T) {
	b := &recordingBinder{registerErr: errors.New("stop here")}
	lc, base, _ := egressLauncher(t, b)
	seedSnapshot(t, base)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	b.onRegister = cancel // the Exec is abandoned while Register is in flight
	_, _ = lc.Restore(ctx, RestoreRequest{ID: "vm-6", Key: "sess-1", WorkspaceDir: base, GuestRAMBytes: 256 << 20})
	if b.registerCtxErr != nil {
		t.Errorf("Register's ctx was cancelled with the caller's (%v); it must be detached", b.registerCtxErr)
	}
	if !b.registerHasDL {
		t.Error("Register's ctx has no deadline; egressControlTimeout must still bound it")
	}
}

func TestGateEgressTeardownOrdering(t *testing.T) {
	base := shortdir.New(t, "fcto", len("/root/run/v.sock_1025"))
	jail := filepath.Join(base, "root")
	if err := os.MkdirAll(filepath.Join(jail, "run"), 0o700); err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(jail, "run", "v.sock_1025")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sleep", "60")
	fcIsolateProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	b := &recordingBinder{}
	var reaped, pathThere bool
	b.onUnregister = func() {
		reaped = errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
		_, statErr := os.Lstat(sock)
		pathThere = statErr == nil
	}
	vm := &firecrackerVM{id: "vm-3", cmd: cmd, jailRoot: jail, egress: b, egressLn: ln}
	if err := vm.Destroy(); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	if !reaped {
		t.Error("Unregister ran before the VMM was killed and reaped")
	}
	if !pathThere {
		t.Error("the socket path was already gone at Unregister time; unlink must come last")
	}
	if ev := b.log(); len(ev) != 1 || ev[0] != "unregister:vm-3" {
		t.Errorf("events = %v, want exactly one unregister", ev)
	}
	if _, statErr := os.Lstat(sock); !os.IsNotExist(statErr) {
		t.Errorf("socket path survives Destroy: %v", statErr)
	}
	if _, statErr := os.Stat(jail); !os.IsNotExist(statErr) {
		t.Errorf("jail survives Destroy: %v", statErr)
	}
}

func TestEgressUnregisterFailureDoesNotFailDestroy(t *testing.T) {
	base := shortdir.New(t, "fcuf", len("/root/run/v.sock_1025"))
	jail := filepath.Join(base, "root")
	if err := os.MkdirAll(filepath.Join(jail, "run"), 0o700); err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(jail, "run", "v.sock_1025")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sleep", "60")
	fcIsolateProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	b := &recordingBinder{unregisterErr: errors.New("moca-egress unreachable")}
	vm := &firecrackerVM{id: "vm-5", cmd: cmd, jailRoot: jail, egress: b, egressLn: ln}
	if err := vm.Destroy(); err != nil {
		t.Fatalf("Destroy = %v; an Unregister failure is harmless and must only be logged", err)
	}
	if ev := b.log(); len(ev) != 1 || ev[0] != "unregister:vm-5" {
		t.Errorf("events = %v, want exactly one unregister", ev)
	}
	if _, statErr := os.Lstat(sock); !os.IsNotExist(statErr) {
		t.Errorf("socket path survives Destroy: %v", statErr)
	}
}

func TestEgressOffLeavesRestoreUnchanged(t *testing.T) {
	lc, base, marker := egressLauncher(t, nil)
	seedSnapshot(t, base)
	_ = restoreShort(lc, base, "vm-4")
	got, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("jailer never ran: %v", err)
	}
	if strings.TrimSpace(string(got)) != "no" {
		t.Fatalf("egress socket existed with Egress nil (marker %q)", got)
	}
}

func TestFirecrackerRefusesAnEgressSocketPathTooLong(t *testing.T) {
	// The egress path (<jail>/run/v.sock_<port>) is never longer than the API socket path
	// (<jail>/run/firecracker.socket) for a port of up to 10 digits, so a base too long for it is
	// refused by the API check whether egress is on or off; the egress check stays as a guard for
	// a longer egress path. Both refuse a 90-byte base, naming sun_path and a length.
	base := "/tmp/" + strings.Repeat("a", 85)
	for _, egress := range []bool{false, true} {
		opts := FirecrackerOptions{
			JailerBin: "/j", FirecrackerBin: "/usr/bin/firecracker", ChrootBase: base, SnapshotDir: "/s",
		}
		if egress {
			opts.Egress = &recordingBinder{}
		}
		_, err := NewFirecrackerLauncher(opts)
		if err == nil || !strings.Contains(err.Error(), "sun_path") {
			t.Fatalf("egress=%v: a 90-byte base was accepted or the error does not name sun_path: %v", egress, err)
		}
	}
	opts := FirecrackerOptions{EgressPort: 4294967295, ChrootBase: base, FirecrackerBin: "/usr/bin/firecracker"}
	if len(opts.maxEgressSocketPath()) > len(opts.maxAPISocketPath()) {
		t.Fatal("the egress socket path can be longer than the API socket path: the API check no longer covers it")
	}
}

func TestFirecrackerRefusesAnAPISocketPathTooLong(t *testing.T) {
	// The API socket is dialled with egress off too. 61 + "/firecracker/vm-<20>/root/run/firecracker.socket"
	// (64) = 125 bytes: refused. A chroot base named after a long template id hits it.
	opts := FirecrackerOptions{
		JailerBin: "/j", FirecrackerBin: "/usr/bin/firecracker", SnapshotDir: "/s",
		ChrootBase: "/srv/sbx/jail/sbx_example_org_example_proj_12345_0123456789ab",
	}
	_, err := NewFirecrackerLauncher(opts)
	if err == nil {
		t.Fatal("a too-long API socket path was accepted with egress off")
	}
	want := len(opts.maxAPISocketPath())
	if !strings.Contains(err.Error(), "API socket path") || !strings.Contains(err.Error(), strconvItoa(want)) {
		t.Errorf("error %q should name the API socket path and the length %d", err, want)
	}
	opts.ChrootBase = "/srv/sbx/jail/j0123456789ab"
	if _, err := NewFirecrackerLauncher(opts); err != nil {
		t.Fatalf("a short base was refused: %v", err)
	}
}

func strconvItoa(n int) string {
	const digits = "0123456789"
	if n == 0 {
		return "0"
	}
	var s string
	for ; n > 0; n /= 10 {
		s = string(digits[n%10]) + s
	}
	return s
}

func TestLauncherFromEnvRefusesEgressOnCloudHypervisor(t *testing.T) {
	_, err := LauncherFromEnv(CloudHypervisor, envFrom(map[string]string{"MOCA_EGRESS_CONTROL_SOCK": "/x"}), t.TempDir(), 256<<20, "t")
	if err == nil || err.Error() != "egress (MOCA_EGRESS_CONTROL_SOCK) is supported on the firecracker VMM only" {
		t.Fatalf("err = %v", err)
	}
}

func TestLauncherFromEnvWiresEgressFromControlSock(t *testing.T) {
	lc, err := LauncherFromEnv(Firecracker, envFrom(map[string]string{"MOCA_EGRESS_CONTROL_SOCK": "/x"}), t.TempDir(), 256<<20, "t")
	if err != nil {
		t.Fatal(err)
	}
	fc := lc.(*firecrackerLauncher)
	if _, ok := fc.opts.Egress.(*control.Client); !ok {
		t.Fatalf("opts.Egress = %T, want *control.Client", fc.opts.Egress)
	}
	if fc.opts.EgressPort != 1025 {
		t.Errorf("EgressPort = %d", fc.opts.EgressPort)
	}
	lc2, err := LauncherFromEnv(Firecracker, envFrom(nil), t.TempDir(), 256<<20, "t")
	if err != nil {
		t.Fatal(err)
	}
	if lc2.(*firecrackerLauncher).opts.Egress != nil {
		t.Error("egress must stay off when the control socket is unset")
	}
}

// A jailer (or a Firecracker) that fails says why on stdout/stderr; the restore's error carries
// the tail of it, instead of only the socket timeout.
func TestFirecrackerRestoreErrorCarriesTheJailerOutput(t *testing.T) {
	base := shortdir.New(t, "fcout", len("/firecracker/vm-6/root/run/firecracker.socket"))
	jailer := filepath.Join(base, "jailer")
	script := "#!/bin/sh\necho 'jailer: Failed to chroot: Os { code: 2 }' >&2\necho second line\nexit 1\n"
	if err := os.WriteFile(jailer, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	lc, err := NewFirecrackerLauncher(FirecrackerOptions{
		JailerBin: jailer, FirecrackerBin: filepath.Join(base, "firecracker"),
		ChrootBase: base, SnapshotDir: base, UID: os.Getuid(), GID: os.Getgid(),
	})
	if err != nil {
		t.Fatalf("NewFirecrackerLauncher: %v", err)
	}
	seedSnapshot(t, base)
	err = restoreShort(lc, base, "vm-5")
	if err == nil {
		t.Fatal("a restore whose jailer exits 1 succeeded")
	}
	for _, want := range []string{"API socket never appeared", "jailer output:", "Failed to chroot: Os { code: 2 }", "second line"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q lacks %q", err, want)
		}
	}
}

func TestTailBufferKeepsTheLastBytes(t *testing.T) {
	tb := newTailBuffer(8)
	if got := tb.String(); got != "(none)" {
		t.Fatalf("empty = %q", got)
	}
	_, _ = tb.Write([]byte("abcdef\n"))
	_, _ = tb.Write([]byte("ghij\n"))
	if got := tb.String(); got != "ef | ghij" {
		t.Fatalf("tail = %q, want the last 8 bytes on one line", got)
	}
}
