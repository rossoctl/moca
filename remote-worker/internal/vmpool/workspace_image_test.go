package vmpool

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The image size every test below builds. Small on purpose: these tests are about the
// ORDER in which a workspace image becomes visible, not about ext4, and the production
// 2 GiB would only make them slow. Still larger than ext4MagicOffset, or "formatted" and
// "too short to tell" would be the same file.
const testImageBytes = 8 << 10

// stampExt4 writes the ext4 superblock magic into an already-sized file, standing in for
// mkfs.ext4 — which the rig and Linux CI have and a macOS developer machine does not.
// workspaceImageFormatted reads exactly this, so a stamped file is indistinguishable from
// a real filesystem as far as the code under test is concerned.
func stampExt4(t *testing.T, path string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		t.Fatalf("stamping %s: %v", path, err)
	}
	defer func() { _ = f.Close() }()
	var b [2]byte
	binary.LittleEndian.PutUint16(b[:], ext4Magic)
	if _, err := f.WriteAt(b[:], ext4MagicOffset); err != nil {
		t.Fatalf("stamping %s: %v", path, err)
	}
}

// fakeMkfs installs a formatter for the duration of one test and records every path it
// was asked to format. onFormat runs before the magic is stamped, so a test can inspect
// or block the half-built state.
func fakeMkfs(t *testing.T, onFormat func(path string)) *[]string {
	t.Helper()
	var mu sync.Mutex
	var seen []string
	real := mkfsExt4
	t.Cleanup(func() { mkfsExt4 = real })
	mkfsExt4 = func(_ context.Context, path string) error {
		mu.Lock()
		seen = append(seen, path)
		mu.Unlock()
		if onFormat != nil {
			onFormat(path)
		}
		stampExt4(t, path)
		return nil
	}
	return &seen
}

// TestAFormattedWorkspaceImageIsReusedAndNotRebuilt is the presence half: the check this
// finding adds must not reject a good image, or every second Restore for a run would
// re-mkfs the workspace out from under it. That is the failure mode a wrong fix here
// produces, so it is asserted before anything about the broken cases.
func TestAFormattedWorkspaceImageIsReusedAndNotRebuilt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workspace.img")
	seen := fakeMkfs(t, nil)

	for i := 0; i < 3; i++ {
		if err := ensureWorkspaceImage(context.Background(), path, testImageBytes); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if len(*seen) != 1 {
		t.Fatalf("formatted %d times across three calls, want 1 — a good image must be reused, not rebuilt", len(*seen))
	}
	if ok, err := workspaceImageFormatted(path); err != nil || !ok {
		t.Fatalf("workspaceImageFormatted = %v, %v — want a formatted image at the final path", ok, err)
	}
}

// TestAnUnformattedWorkspaceImageIsRebuiltRatherThanInherited is the durable half of the
// finding. The pre-fix code created and Truncate'd the file well before mkfs ran on it,
// so a worker killed in that window left a 2 GiB zero-filled file which every later
// Restore hardlinked and every `mount /dev/vdb` in Resume then failed on, for the whole
// WorkspaceIdle window, with no self-healing.
func TestAnUnformattedWorkspaceImageIsRebuiltRatherThanInherited(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workspace.img")
	// Exactly what the old code left behind: created, sized, never formatted.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(testImageBytes); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if ok, err := workspaceImageFormatted(path); err != nil || ok {
		t.Fatalf("workspaceImageFormatted on a zero-filled file = %v, %v — want false", ok, err)
	}

	seen := fakeMkfs(t, nil)
	if err := ensureWorkspaceImage(context.Background(), path, testImageBytes); err != nil {
		t.Fatalf("ensureWorkspaceImage over an unformatted image: %v", err)
	}
	if len(*seen) != 1 {
		t.Fatalf("formatted %d times, want 1 — an unformatted image must be rebuilt, not treated as valid", len(*seen))
	}
	if ok, err := workspaceImageFormatted(path); err != nil || !ok {
		t.Fatalf("workspaceImageFormatted after the rebuild = %v, %v — want a formatted image", ok, err)
	}
}

// TestAHalfBuiltWorkspaceImageIsNeverVisibleAtTheFinalPath pins the ordering property
// itself, which is what makes the durable case unreachable rather than merely
// self-healing: nothing appears at the image's real name until it is a finished
// filesystem, so a build that dies part-way leaves at most a temp file no Restore will
// ever hardlink.
func TestAHalfBuiltWorkspaceImageIsNeverVisibleAtTheFinalPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "workspace.img")

	var formatted string
	real := mkfsExt4
	t.Cleanup(func() { mkfsExt4 = real })
	mkfsExt4 = func(_ context.Context, p string) error {
		formatted = p
		// The image is sized but unformatted at this instant. Under the old code this
		// was the final path, and a killed worker (or a failing mkfs whose cleanup
		// Remove also failed) left it there.
		if _, err := os.Stat(path); err == nil {
			return errors.New("the final image path already exists while the image is still being built")
		}
		return errors.New("mkfs killed")
	}

	err := ensureWorkspaceImage(context.Background(), path, testImageBytes)
	if err == nil {
		t.Fatal("ensureWorkspaceImage returned nil for a mkfs that failed")
	}
	if strings.Contains(err.Error(), "already exists while") {
		t.Fatalf("%v — a half-built image must never be visible under its final name", err)
	}
	if formatted == path {
		t.Fatalf("mkfs was pointed at the final path %s; it must format a temp name and be linked into place", path)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("stat(%s) after a failed build: err = %v, want IsNotExist", path, err)
	}
	// And nothing is left lying around to be mistaken for an image later.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("workspace directory holds %v after a failed build, want nothing", names)
	}
}

// TestConcurrentWorkspaceImageBuildsNeverExposeAnUnformattedImage is the concurrent half.
// A replenish timer firing while a cold warm is mid-mkfs for the same key is reachable —
// replenishOne only checks len(ready)+warming against StandbyDepth — and the old code's
// second caller saw the file present, returned nil, and hardlinked an unformatted image.
// The invariant asserted here is the one that matters to Restore: whenever this function
// returns nil, the image at the final path is formatted.
func TestConcurrentWorkspaceImageBuildsNeverExposeAnUnformattedImage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "workspace.img")

	const builders = 4
	inFormat := make(chan struct{}, builders)
	release := make(chan struct{})
	seen := fakeMkfs(t, func(string) {
		inFormat <- struct{}{}
		<-release
	})

	var wg sync.WaitGroup
	errs := make(chan error, builders)
	for i := 0; i < builders; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := ensureWorkspaceImage(context.Background(), path, testImageBytes); err != nil {
				errs <- err
				return
			}
			// The whole point: a nil return is a promise about the final path.
			if ok, err := workspaceImageFormatted(path); err != nil {
				errs <- err
			} else if !ok {
				errs <- errors.New("ensureWorkspaceImage returned nil while the image at the final path was NOT formatted")
			}
		}()
	}
	// Hold the first builder inside its formatter — the window in which the image is
	// half-built — and give the others long enough to make the old mistake. Deliberately
	// NOT "wait for all four to reach the formatter": under the pre-fix code the other
	// three return early instead of formatting anything, so waiting for them would hang
	// on the very regression this test exists to catch.
	select {
	case <-inFormat:
	case <-time.After(testWaitBound):
		t.Fatal("no builder ever reached the formatter")
	}
	select {
	case err := <-errs:
		close(release)
		t.Fatalf("a builder finished while the image was still being built: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	close(release)

	waited := make(chan struct{})
	go func() { wg.Wait(); close(waited) }()
	select {
	case <-waited:
	case <-time.After(testWaitBound):
		t.Fatal("a builder never returned after the formatter was released")
	}
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent build: %v", err)
	}
	if len(*seen) == 0 {
		t.Fatal("nothing was formatted at all — the test did not exercise a build")
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "workspace.img" {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("workspace directory holds %v, want only workspace.img — the losing builders must clean up their own temp images", names)
	}
}
