package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/rossoctl/moca/remote-worker/internal/vmpool"
)

// templateRecord is the part of template-build.sh's template record (schema
// moca-sbx-template/1) a worker checks its snapshot against at start. The record is what
// the control plane registers; without this check a worker could serve a snapshot other
// than the one its template's record names.
type templateRecord struct {
	Schema         string `json:"schema"`
	ID             string `json:"id"`
	Worker         string `json:"worker"`
	Snapshot       string `json:"snapshot"`
	Image          string `json:"image"`
	GuestRAMMB     int64  `json:"guest_ram_mb"`
	ManifestHash   string `json:"manifest_hash"`
	EgressCASHA256 string `json:"egress_ca_sha256"`
}

const templateRecordSchema = "moca-sbx-template/1"

// verifyTemplateRecord checks the record at path against the snapshot's manifest and this
// worker's identity. Every mismatch is named; the first one refuses the start. An empty
// path is no check (a worker installed without a record, as before).
func verifyTemplateRecord(path string, man vmpool.Manifest, snapshot, sandboxID, template string) error {
	if path == "" {
		return nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("template record: %w", err)
	}
	var r templateRecord
	if err := json.Unmarshal(b, &r); err != nil {
		return fmt.Errorf("template record %s: %w", path, err)
	}
	if r.Schema != templateRecordSchema {
		return fmt.Errorf("template record %s: schema %q, want %q", path, r.Schema, templateRecordSchema)
	}
	var bad []string
	differ := func(what, record, here string) {
		if record != here {
			bad = append(bad, fmt.Sprintf("%s: record %q, here %q", what, record, here))
		}
	}
	differ("manifest_hash", r.ManifestHash, man.Hash)
	differ("snapshot", r.Snapshot, snapshot)
	differ("egress_ca_sha256", r.EgressCASHA256, man.EgressCASHA256)
	if r.GuestRAMMB != man.GuestRAMMB {
		bad = append(bad, fmt.Sprintf("guest_ram_mb: record %d, manifest %d", r.GuestRAMMB, man.GuestRAMMB))
	}
	if sandboxID != "" {
		differ("worker", r.Worker, sandboxID)
	}
	if template != "" {
		differ("id", r.ID, template)
	}
	// The image digest the rootfs was exported from (build-rootfs.sh's
	// /etc/moca-rootfs-source, copied into a version-2 manifest as source_image_digest).
	// A version-1 manifest does not carry it: the check is skipped, and says so in the log.
	if man.SourceImageDigest != "" {
		_, dig, ok := strings.Cut(r.Image, "@")
		if !ok {
			bad = append(bad, fmt.Sprintf("image: record %q is not pinned by digest", r.Image))
		} else {
			differ("image digest", dig, man.SourceImageDigest)
		}
	}
	if len(bad) > 0 {
		return fmt.Errorf("template record %s does not describe this worker's snapshot (%s): "+
			"rebuild the template or reinstall the worker with its own record", path, strings.Join(bad, "; "))
	}
	return nil
}
