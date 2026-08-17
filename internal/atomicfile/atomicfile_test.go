package atomicfile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteCreatesFileWithContentsAndMode(t *testing.T) {
	tests := []struct {
		name string
		perm os.FileMode
		data string
	}{
		{"world readable", 0o644, "hello"},
		{"owner only", 0o600, "secret"},
		{"empty file", 0o644, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "f.json")
			if err := Write(path, []byte(tt.data), tt.perm); err != nil {
				t.Fatalf("Write: %v", err)
			}

			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("ReadFile: %v", err)
			}
			if string(got) != tt.data {
				t.Errorf("contents: got %q, want %q", got, tt.data)
			}

			// CreateTemp makes 0600; the caller's mode must survive the rename.
			fi, err := os.Stat(path)
			if err != nil {
				t.Fatalf("Stat: %v", err)
			}
			if fi.Mode().Perm() != tt.perm {
				t.Errorf("mode: got %v, want %v", fi.Mode().Perm(), tt.perm)
			}
		})
	}
}

func TestWriteReplacesExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "f.json")
	if err := os.WriteFile(path, []byte("old contents, longer"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Write(path, []byte("new"), 0o644); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "new" {
		t.Errorf("got %q, want %q — a shorter replacement must not leave a tail", got, "new")
	}
}

// The temp file is the whole mechanism; leaving one behind on either path would
// litter the config directory with a file per save.
func TestWriteLeavesNoTempBehind(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "projects.json")

	for i := 0; i < 3; i++ {
		if err := Write(path, []byte("x"), 0o644); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("temp file left behind: %s", e.Name())
		}
	}
	if len(entries) != 1 {
		t.Errorf("got %d entries, want 1 (the target alone)", len(entries))
	}
}

// A failure must leave the previous file untouched rather than truncated —
// the entire reason this package exists.
func TestFailedWriteLeavesTheOriginalIntact(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "projects.json")
	if err := os.WriteFile(path, []byte("precious"), 0o644); err != nil {
		t.Fatal(err)
	}

	// An unwritable directory means CreateTemp fails, standing in for any
	// mid-write failure: the target must not have been opened at all.
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Skipf("cannot make dir read-only: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	if err := Write(path, []byte("replacement"), 0o644); err == nil {
		t.Skip("directory is still writable (running as root?)")
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("original is gone: %v", err)
	}
	if string(got) != "precious" {
		t.Errorf("original was damaged: got %q, want %q", got, "precious")
	}
}
