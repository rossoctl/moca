package vmpool

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadMemAvailableFrom(t *testing.T) {
	const meminfo = "MemTotal:       16303428 kB\n" +
		"MemFree:          402680 kB\n" +
		"MemAvailable:    1503232 kB\n" +
		"Buffers:          123456 kB\n"
	for _, tc := range []struct {
		name, content string
		want          int64
		wantErr       string
	}{
		{"kernel format", meminfo, 1503232 * 1024, ""},
		{"last line, no trailing newline", "MemTotal: 1 kB\nMemAvailable: 2 kB", 2 * 1024, ""},
		{"surrounding whitespace", "MemAvailable:\t 7 kB \t\n", 7 * 1024, ""},
		{"zero", "MemAvailable: 0 kB\n", 0, ""},
		{"absent key", "MemTotal: 1 kB\nMemFree: 1 kB\n", 0, "no MemAvailable line"},
		{"MemFree only", "MemFree: 402680 kB\n", 0, "no MemAvailable line"},
		{"empty file", "", 0, "no MemAvailable line"},
		{"key not at line start", " MemAvailable: 1 kB\n", 0, "no MemAvailable line"},
		{"no unit", "MemAvailable: 1503232\n", 0, `want "<n> kB"`},
		{"wrong unit", "MemAvailable: 1468 MB\n", 0, `want "<n> kB"`},
		{"no value", "MemAvailable:\n", 0, `want "<n> kB"`},
		{"non-numeric", "MemAvailable: lots kB\n", 0, `"lots"`},
		{"overflow", "MemAvailable: 99999999999999999999 kB\n", 0, "value out of range"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "meminfo")
			if err := os.WriteFile(path, []byte(tc.content), 0o644); err != nil {
				t.Fatal(err)
			}
			got, err := readMemAvailableFrom(path)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("readMemAvailableFrom(%q) = %d, %v; want an error containing %q", tc.content, got, err, tc.wantErr)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("readMemAvailableFrom(%q) = %d, %v; want %d", tc.content, got, err, tc.want)
			}
		})
	}

	t.Run("missing file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "meminfo")
		_, err := readMemAvailableFrom(path)
		if !errors.Is(err, fs.ErrNotExist) || !strings.Contains(err.Error(), path) {
			t.Fatalf("err = %v, want a not-exist error naming the path", err)
		}
	})
	t.Run("unreadable", func(t *testing.T) {
		if got, err := readMemAvailableFrom(t.TempDir()); err == nil {
			t.Fatalf("readMemAvailableFrom on a directory = %d, want an error", got)
		}
	})
}
