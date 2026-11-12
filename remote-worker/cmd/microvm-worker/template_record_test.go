package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rossoctl/moca/remote-worker/internal/vmpool"
)

const testDigest = "sha256:0123456789ab" + "cdef0123456789abcdef0123456789abcdef0123456789abcdef"

func recordMan() vmpool.Manifest {
	return vmpool.Manifest{HashVersion: vmpool.HashVersionAll, Hash: "sha256:h1", GuestRAMMB: 4096,
		SourceImageDigest: testDigest}
}

func writeRecord(t *testing.T, edit func(map[string]any)) string {
	t.Helper()
	r := map[string]any{
		"schema": "moca-sbx-template/1", "id": "py-tools",
		"worker": "sbx_py_tools_0123456789ab", "snapshot": "py-tools-0123456789ab",
		"image": "example/py-tools@" + testDigest, "guest_ram_mb": 4096,
		"manifest_hash": "sha256:h1",
	}
	if edit != nil {
		edit(r)
	}
	b, _ := json.Marshal(r)
	p := filepath.Join(t.TempDir(), "rec.json")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func check(t *testing.T, path string, man vmpool.Manifest) error {
	t.Helper()
	return verifyTemplateRecord(path, man, "py-tools-0123456789ab",
		"sbx_py_tools_0123456789ab", "py-tools")
}

func TestTemplateRecordMatches(t *testing.T) {
	if err := check(t, writeRecord(t, nil), recordMan()); err != nil {
		t.Fatalf("a matching record was refused: %v", err)
	}
}

func TestTemplateRecordUnsetIsNoCheck(t *testing.T) {
	if err := verifyTemplateRecord("", recordMan(), "x", "y", "z"); err != nil {
		t.Fatal(err)
	}
}

func TestTemplateRecordRefusesEachMismatch(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(map[string]any)
		want string
	}{
		{"manifest hash", func(r map[string]any) { r["manifest_hash"] = "sha256:other" }, "manifest_hash"},
		{"snapshot", func(r map[string]any) { r["snapshot"] = "other" }, "snapshot"},
		{"worker", func(r map[string]any) { r["worker"] = "sbx_other" }, "worker"},
		{"template id", func(r map[string]any) { r["id"] = "other" }, "id:"},
		{"guest ram", func(r map[string]any) { r["guest_ram_mb"] = 2048 }, "guest_ram_mb"},
		{"image digest", func(r map[string]any) {
			r["image"] = "registry.example.com/x@sha256:" + strings.Repeat("0", 64)
		}, "image digest"},
		{"image by tag", func(r map[string]any) { r["image"] = "registry.example.com/x:latest" }, "not pinned"},
		{"egress ca", func(r map[string]any) { r["egress_ca_sha256"] = "sha256:ca" }, "egress_ca_sha256"},
		{"schema", func(r map[string]any) { r["schema"] = "other-template/1" }, "schema"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := check(t, writeRecord(t, tc.edit), recordMan())
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to name %q", err, tc.want)
			}
		})
	}
}

// A version-1 manifest has no source_image_digest: the record's image cannot be compared,
// and the rest still is.
func TestTemplateRecordV1ManifestSkipsOnlyTheImage(t *testing.T) {
	man := vmpool.Manifest{Hash: "sha256:h1", GuestRAMMB: 4096}
	rec := writeRecord(t, func(r map[string]any) { r["image"] = "registry.example.com/x:latest" })
	if err := check(t, rec, man); err != nil {
		t.Fatalf("a v1 manifest's record was refused for its image: %v", err)
	}
	if err := check(t, writeRecord(t, func(r map[string]any) { r["manifest_hash"] = "sha256:no" }), man); err == nil {
		t.Fatal("a v1 manifest's record with another hash was accepted")
	}
}

func TestTemplateRecordMissingFileRefuses(t *testing.T) {
	if err := check(t, filepath.Join(t.TempDir(), "absent.json"), recordMan()); err == nil {
		t.Fatal("a missing record was accepted")
	}
}
