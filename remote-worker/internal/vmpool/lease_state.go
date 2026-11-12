package vmpool

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
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

// saveLeaseState writes key's state atomically and durably: a temp file in the same
// directory, fsync, rename over the old file, fsync the directory. A crash leaves the
// old file or the new one, never a torn one -- and a torn one would read as unknown,
// which is safe but loses a restored mode.
func saveLeaseState(root, key string, s leaseState) error {
	if err := checkKey(key); err != nil {
		return err
	}
	b, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("lease state for %q: %w", key, err)
	}
	dir := filepath.Join(root, leaseStateDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("lease state dir: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "."+key+".json.tmp-*")
	if err != nil {
		return fmt.Errorf("lease state for %q: %w", key, err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }() // a no-op once the rename succeeded
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("lease state for %q: write: %w", key, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("lease state for %q: fsync: %w", key, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("lease state for %q: close: %w", key, err)
	}
	if err := os.Rename(tmp.Name(), leaseStatePath(root, key)); err != nil {
		return fmt.Errorf("lease state for %q: rename: %w", key, err)
	}
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("lease state dir: %w", err)
	}
	defer func() { _ = d.Close() }()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("lease state dir: fsync: %w", err)
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

// retireLeaseState is what removing key's workspace does to its state file. With an
// event pending, the file is rewritten to hold that event only (ruling R9: spec §5 keeps
// the last end event until a client has seen it): Known false, so the mode is per-exec
// and the epoch unknown until SetMode, exactly as for a deleted file, and RootWrote false,
// which unknown state already treats as true (ruling R7). With nothing pending it is
// deleted.
func retireLeaseState(root, key string, s leaseState) {
	if s.Pending == nil {
		removeLeaseState(root, key)
		return
	}
	if err := saveLeaseState(root, key, leaseState{Pending: s.Pending}); err != nil {
		log.Printf("vmpool: keep the pending lease event for %q: %v", key, err)
	}
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
