package share

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"yv/internal/models"
)

func TestSafeName(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"plain name is kept", "notes.txt", "notes.txt"},
		{"spaces are fine", "my report.pdf", "my report.pdf"},
		{"unix path is reduced to its base", "/etc/passwd", "passwd"},
		{"relative path is reduced too", "../../etc/passwd", "passwd"},
		{"windows path is reduced", `C:\Windows\System32\drivers\etc\hosts`, "hosts"},
		{"bare parent entry cannot address a directory", "..", "received-file"},
		{"single dot likewise", ".", "received-file"},
		{"leading dot is stripped so the file is visible", ".bashrc", "bashrc"},
		{"trailing separator leaves nothing to name", "dir/", "received-file"},
		{"control characters are dropped", "no\x00te\x07s.txt", "notes.txt"},
		{"newline is dropped", "notes\n.txt", "notes.txt"},
		{"empty falls back", "", "received-file"},
		{"whitespace only falls back", "   ", "received-file"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := SafeName(tc.in)
			if got != tc.want {
				t.Errorf("SafeName(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// The property that actually matters: whatever comes back, joining it onto a
// directory must stay inside that directory.
func TestSafeNameStaysInsideTheDirectory(t *testing.T) {
	hostile := []string{
		"../../../../etc/passwd",
		"..",
		"../",
		`..\..\windows\system32\config\sam`,
		"/absolute/path/file",
		"a/b/c",
		"",
	}

	dir := t.TempDir()
	for _, in := range hostile {
		got := filepath.Join(dir, SafeName(in))
		rel, err := filepath.Rel(dir, got)
		if err != nil {
			t.Fatalf("SafeName(%q) -> %q: %v", in, got, err)
		}
		if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			t.Errorf("SafeName(%q) escaped the directory: %q", in, rel)
		}
		if strings.ContainsRune(rel, filepath.Separator) {
			t.Errorf("SafeName(%q) kept a separator: %q", in, rel)
		}
	}
}

func TestSafeNameTruncatesButKeepsTheExtension(t *testing.T) {
	long := strings.Repeat("a", 400) + ".tar.gz"
	got := SafeName(long)

	if len(got) > 120 {
		t.Errorf("name is %d chars, want <= 120", len(got))
	}
	if filepath.Ext(got) != ".gz" {
		t.Errorf("extension lost: %q", got)
	}
}

func TestPrepareFiles(t *testing.T) {
	dir := t.TempDir()

	small := filepath.Join(dir, "small.txt")
	if err := os.WriteFile(small, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dir, "other.bin")
	if err := os.WriteFile(other, []byte{0x00, 0x01, 0x02}, 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("reads what was picked", func(t *testing.T) {
		files, err := PrepareFiles([]string{small, other})
		if err != nil {
			t.Fatalf("PrepareFiles: %v", err)
		}
		if len(files) != 2 {
			t.Fatalf("got %d files, want 2", len(files))
		}
		if files[0].Name != "small.txt" || string(files[0].Data) != "hello" {
			t.Errorf("first file wrong: %+v", files[0])
		}
		if files[0].Size != 5 {
			t.Errorf("size = %d, want 5", files[0].Size)
		}
	})

	t.Run("empty selection is an error, not an empty transfer", func(t *testing.T) {
		if _, err := PrepareFiles(nil); err == nil {
			t.Error("expected an error for no files")
		}
	})

	t.Run("a directory is refused rather than skipped", func(t *testing.T) {
		_, err := PrepareFiles([]string{dir})
		if err == nil || !strings.Contains(err.Error(), "folder") {
			t.Errorf("err = %v, want a folder complaint", err)
		}
	})

	t.Run("a missing file is refused", func(t *testing.T) {
		if _, err := PrepareFiles([]string{filepath.Join(dir, "nope.txt")}); err == nil {
			t.Error("expected an error for a missing file")
		}
	})

	t.Run("too many files", func(t *testing.T) {
		paths := make([]string, MaxFiles+1)
		for i := range paths {
			paths[i] = small
		}
		if _, err := PrepareFiles(paths); err == nil {
			t.Error("expected an error over the file count cap")
		}
	})

	// The size guard has to reject before reading, or refusing an oversized file
	// would still cost the memory it was meant to save.
	t.Run("an oversized file is refused", func(t *testing.T) {
		big := filepath.Join(dir, "big.bin")
		f, err := os.Create(big)
		if err != nil {
			t.Fatal(err)
		}
		// Sparse: the guard reads the size, not the bytes.
		if err := f.Truncate(MaxFileBytes + 1); err != nil {
			_ = f.Close()
			t.Skipf("cannot make a sparse file here: %v", err)
		}
		_ = f.Close()

		_, err = PrepareFiles([]string{big})
		if err == nil || !strings.Contains(err.Error(), "at most per file") {
			t.Errorf("err = %v, want a per-file size complaint", err)
		}
	})
}

func TestSaveFiles(t *testing.T) {
	t.Run("writes into a directory it creates", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "nested", ReceiveDirName)

		written, err := SaveFiles(dir, []models.SharedFile{
			{Name: "a.txt", Data: []byte("one")},
			{Name: "b.txt", Data: []byte("two")},
		})
		if err != nil {
			t.Fatalf("SaveFiles: %v", err)
		}
		if len(written) != 2 {
			t.Fatalf("wrote %d files, want 2", len(written))
		}
		got, err := os.ReadFile(filepath.Join(dir, "a.txt"))
		if err != nil || string(got) != "one" {
			t.Errorf("a.txt = %q, %v", got, err)
		}
	})

	t.Run("an existing file is never overwritten", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("mine"), 0o644); err != nil {
			t.Fatal(err)
		}

		written, err := SaveFiles(dir, []models.SharedFile{{Name: "a.txt", Data: []byte("theirs")}})
		if err != nil {
			t.Fatalf("SaveFiles: %v", err)
		}
		if filepath.Base(written[0]) != "a (2).txt" {
			t.Errorf("wrote %q, want a (2).txt", filepath.Base(written[0]))
		}
		mine, _ := os.ReadFile(filepath.Join(dir, "a.txt"))
		if string(mine) != "mine" {
			t.Errorf("existing file was clobbered: %q", mine)
		}
	})

	t.Run("two files with the same name both land", func(t *testing.T) {
		dir := t.TempDir()

		written, err := SaveFiles(dir, []models.SharedFile{
			{Name: "dup.txt", Data: []byte("first")},
			{Name: "dup.txt", Data: []byte("second")},
		})
		if err != nil {
			t.Fatalf("SaveFiles: %v", err)
		}
		if written[0] == written[1] {
			t.Fatalf("both files went to %q", written[0])
		}
		second, _ := os.ReadFile(written[1])
		if string(second) != "second" {
			t.Errorf("second file = %q", second)
		}
	})

	// SaveFiles sanitises again rather than trusting that the caller did: it is
	// the last step before a path is written.
	t.Run("a hostile name cannot escape the directory", func(t *testing.T) {
		dir := t.TempDir()
		outside := filepath.Join(dir, "outside")
		if err := os.Mkdir(outside, 0o755); err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(outside, "landing")

		written, err := SaveFiles(target, []models.SharedFile{
			{Name: "../../escaped.txt", Data: []byte("nope")},
		})
		if err != nil {
			t.Fatalf("SaveFiles: %v", err)
		}
		if filepath.Dir(written[0]) != target {
			t.Errorf("wrote to %q, want inside %q", written[0], target)
		}
	})

	t.Run("nothing to save is not an error", func(t *testing.T) {
		if _, err := SaveFiles(t.TempDir(), nil); err != nil {
			t.Errorf("SaveFiles(nil) = %v", err)
		}
	})
}

func TestHumanSize(t *testing.T) {
	tests := []struct {
		n    int64
		want string
	}{
		{0, "0 B"},
		{512, "512 B"},
		{1024, "1.0 KB"},
		{1536, "1.5 KB"},
		{1 << 20, "1.0 MB"},
		{(1 << 20) * 3 / 2, "1.5 MB"},
		{1 << 30, "1.0 GB"},
		{1 << 40, "1.0 TB"},
	}

	for _, tc := range tests {
		if got := HumanSize(tc.n); got != tc.want {
			t.Errorf("HumanSize(%d) = %q, want %q", tc.n, got, tc.want)
		}
	}
}

func TestReceiveDirIsUnderHome(t *testing.T) {
	dir, err := ReceiveDir()
	if err != nil {
		t.Skipf("no home directory here: %v", err)
	}
	if filepath.Base(dir) != ReceiveDirName {
		t.Errorf("ReceiveDir() = %q, want it to end in %q", dir, ReceiveDirName)
	}
	home, err := os.UserHomeDir()
	if err == nil && !strings.HasPrefix(dir, home) {
		t.Errorf("ReceiveDir() = %q, want it under %q", dir, home)
	}
}
