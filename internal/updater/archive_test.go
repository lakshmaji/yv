package updater

import (
	"archive/zip"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func buildZip(t *testing.T, entries map[string]string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "update.zip")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	w := zip.NewWriter(f)
	for name, body := range entries {
		e, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestExtractZip(t *testing.T) {
	src := buildZip(t, map[string]string{
		"yv.exe":                "the new binary",
		"resources/data.txt":    "some resource",
		"nested/deep/thing.dll": "a library",
	})
	dest := filepath.Join(t.TempDir(), "staged")

	if err := extractZip(context.Background(), src, dest); err != nil {
		t.Fatalf("extractZip: %v", err)
	}

	for name, want := range map[string]string{
		"yv.exe":                "the new binary",
		"resources/data.txt":    "some resource",
		"nested/deep/thing.dll": "a library",
	} {
		got, err := os.ReadFile(filepath.Join(dest, filepath.FromSlash(name)))
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if string(got) != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

// Zip slip: an archive entry named with a traversal writes wherever it likes,
// and the archive here came off the internet. One comparison closes it.
func TestExtractZipRefusesEntriesOutsideItself(t *testing.T) {
	for _, name := range []string{
		"../escaped.txt",
		"../../../../etc/cron.d/evil",
		"nested/../../escaped.txt",
	} {
		t.Run(name, func(t *testing.T) {
			src := buildZip(t, map[string]string{name: "hostile"})
			dest := filepath.Join(t.TempDir(), "staged")

			err := extractZip(context.Background(), src, dest)
			if err == nil {
				t.Fatalf("extracted %q without complaint", name)
			}
			if !strings.Contains(err.Error(), "outside itself") {
				t.Errorf("err = %v, want one about an entry outside the archive", err)
			}
		})
	}
}

// The prefix check compares against the root plus a separator. Without the
// separator, a sibling directory whose name merely starts with the same
// characters passes the test.
func TestExtractZipRootComparisonIncludesTheSeparator(t *testing.T) {
	base := t.TempDir()
	dest := filepath.Join(base, "staged")

	src := buildZip(t, map[string]string{"../staged-evil/payload.txt": "hostile"})
	if err := extractZip(context.Background(), src, dest); err == nil {
		t.Fatal("accepted an entry landing in a sibling directory with a shared prefix")
	}
	if _, err := os.Stat(filepath.Join(base, "staged-evil")); !os.IsNotExist(err) {
		t.Error("the entry was written to the sibling directory")
	}
}

func TestCopyTreeDisplacesRatherThanOverwrites(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "staged")
	dst := filepath.Join(root, "install")
	backup := filepath.Join(root, ".yv-backup")

	mustWrite(t, filepath.Join(src, "yv.exe"), "new binary")
	mustWrite(t, filepath.Join(src, "sub", "lib.dll"), "new library")
	mustWrite(t, filepath.Join(dst, "yv.exe"), "old binary")
	mustWrite(t, filepath.Join(dst, "sub", "lib.dll"), "old library")
	mustWrite(t, filepath.Join(dst, "settings.ini"), "user settings")

	if err := copyTree(src, dst, backup); err != nil {
		t.Fatalf("copyTree: %v", err)
	}

	assertFile(t, filepath.Join(dst, "yv.exe"), "new binary")
	assertFile(t, filepath.Join(dst, "sub", "lib.dll"), "new library")
	// Files the update does not carry are left alone. An update is not a
	// reinstall, and taking out a file the user's own state lives in would be.
	assertFile(t, filepath.Join(dst, "settings.ini"), "user settings")

	// Everything replaced is recoverable until the caller clears the backup.
	assertFile(t, filepath.Join(backup, "yv.exe"), "old binary")
	assertFile(t, filepath.Join(backup, "sub", "lib.dll"), "old library")
}

// A copy that fails part way must not be what the user is left with.
func TestRestoreBackupUndoesAPartialCopy(t *testing.T) {
	root := t.TempDir()
	dst := filepath.Join(root, "install")
	backup := filepath.Join(root, ".yv-backup")

	mustWrite(t, filepath.Join(dst, "yv.exe"), "half-copied new binary")
	mustWrite(t, filepath.Join(dst, "sub", "lib.dll"), "half-copied new library")
	mustWrite(t, filepath.Join(backup, "yv.exe"), "old binary")
	mustWrite(t, filepath.Join(backup, "sub", "lib.dll"), "old library")

	restoreBackup(backup, dst)

	assertFile(t, filepath.Join(dst, "yv.exe"), "old binary")
	assertFile(t, filepath.Join(dst, "sub", "lib.dll"), "old library")
	if _, err := os.Stat(backup); !os.IsNotExist(err) {
		t.Error("restoreBackup left the backup directory behind")
	}
}

func TestCopyFilePreservesContent(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "src.bin")
	dst := filepath.Join(root, "dst.bin")
	mustWrite(t, src, "some bytes")

	if err := copyFile(src, dst, 0o644); err != nil {
		t.Fatalf("copyFile: %v", err)
	}
	assertFile(t, dst, "some bytes")
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func assertFile(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Errorf("%s: %v", path, err)
		return
	}
	if string(got) != want {
		t.Errorf("%s = %q, want %q", path, got, want)
	}
}
