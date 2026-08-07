package share

import (
	"archive/zip"
	"bufio"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
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

// --- StatFiles ---

func TestStatFiles(t *testing.T) {
	dir := t.TempDir()

	small := filepath.Join(dir, "small.txt")
	if err := os.WriteFile(small, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("records what it will take to send, reading nothing", func(t *testing.T) {
		files, err := StatFiles([]string{small})
		if err != nil {
			t.Fatalf("StatFiles: %v", err)
		}
		if len(files) != 1 {
			t.Fatalf("got %d sources, want 1", len(files))
		}
		if files[0].Name != "small.txt" || files[0].Size != 5 || files[0].Path != small {
			t.Errorf("source wrong: %+v", files[0])
		}
	})

	t.Run("empty selection is an error, not an empty transfer", func(t *testing.T) {
		if _, err := StatFiles(nil); err == nil {
			t.Error("expected an error for no files")
		}
	})

	t.Run("a directory is refused rather than skipped", func(t *testing.T) {
		_, err := StatFiles([]string{dir})
		if err == nil || !strings.Contains(err.Error(), "folder") {
			t.Errorf("err = %v, want a folder complaint", err)
		}
	})

	t.Run("a missing file is refused", func(t *testing.T) {
		if _, err := StatFiles([]string{filepath.Join(dir, "nope.txt")}); err == nil {
			t.Error("expected an error for a missing file")
		}
	})

	t.Run("too many files", func(t *testing.T) {
		paths := make([]string, MaxFiles+1)
		for i := range paths {
			paths[i] = small
		}
		if _, err := StatFiles(paths); err == nil {
			t.Error("expected an error over the file count cap")
		}
	})

	// The size guard reads metadata only, so a sparse file over the cap is
	// rejected without a single byte being read — which is the whole reason
	// StatFiles exists rather than PrepareFiles.
	t.Run("an oversized file is refused without reading it", func(t *testing.T) {
		big := filepath.Join(dir, "big.bin")
		f, err := os.Create(big)
		if err != nil {
			t.Fatal(err)
		}
		if err := f.Truncate(MaxFileBytes + 1); err != nil {
			_ = f.Close()
			t.Skipf("cannot make a sparse file here: %v", err)
		}
		_ = f.Close()

		_, err = StatFiles([]string{big})
		if err == nil || !strings.Contains(err.Error(), "at most per file") {
			t.Errorf("err = %v, want a per-file size complaint", err)
		}
	})

	// Each file is within the per-file cap; enough of them together are not.
	// This is the case a per-file check alone would wave through.
	t.Run("the per-transfer cap is enforced across files", func(t *testing.T) {
		big := filepath.Join(dir, "atcap.bin")
		f, err := os.Create(big)
		if err != nil {
			t.Fatal(err)
		}
		if err := f.Truncate(MaxFileBytes); err != nil {
			_ = f.Close()
			t.Skipf("cannot make a sparse file here: %v", err)
		}
		_ = f.Close()

		if _, err := StatFiles([]string{big}); err != nil {
			t.Fatalf("a file exactly at the per-file cap was refused: %v", err)
		}

		n := int(MaxTotalBytes/MaxFileBytes) + 1
		paths := make([]string, n)
		for i := range paths {
			paths[i] = big
		}
		_, err = StatFiles(paths)
		if err == nil || !strings.Contains(err.Error(), "one transfer") {
			t.Errorf("err = %v, want a per-transfer size complaint", err)
		}
	})
}

func TestTotalBytesAndNames(t *testing.T) {
	files := []FileSource{
		{Name: "a.txt", Size: 10},
		{Name: "b.bin", Size: 32},
	}
	if got := TotalBytes(files); got != 42 {
		t.Errorf("TotalBytes = %d, want 42", got)
	}
	names := FileNames(files)
	if len(names) != 2 || names[0] != "a.txt" || names[1] != "b.bin" {
		t.Errorf("FileNames = %v", names)
	}
}

// --- streaming round trip ---

// roundTrip sends the given files through WriteFiles/ReadFiles over a pipe and
// returns what landed.
func roundTrip(t *testing.T, sources []FileSource) (string, []string) {
	t.Helper()

	var wire bytes.Buffer
	if err := WriteFiles(&wire, sources, nil); err != nil {
		t.Fatalf("WriteFiles: %v", err)
	}

	dst := filepath.Join(t.TempDir(), ReceiveDirName)
	written, err := ReadFiles(bufio.NewReader(&wire), dst, MaxTotalBytes, nil)
	if err != nil {
		t.Fatalf("ReadFiles: %v", err)
	}
	return dst, written
}

// sourceFor writes content to a temp file and describes it for sending.
func sourceFor(t *testing.T, name string, content []byte) FileSource {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	return FileSource{Name: name, Size: int64(len(content)), Path: path}
}

func TestStreamRoundTrip(t *testing.T) {
	a := sourceFor(t, "notes.txt", []byte("hello"))
	b := sourceFor(t, "empty.dat", nil)

	binary := make([]byte, 3*copyBufSize+17) // spans several chunks, ends ragged
	for i := range binary {
		binary[i] = byte(i % 251)
	}
	c := sourceFor(t, "blob.bin", binary)

	dir, written := roundTrip(t, []FileSource{a, b, c})
	if len(written) != 3 {
		t.Fatalf("wrote %d files, want 3", len(written))
	}

	got, err := os.ReadFile(filepath.Join(dir, "notes.txt"))
	if err != nil || string(got) != "hello" {
		t.Errorf("notes.txt = %q, %v", got, err)
	}
	if st, err := os.Stat(filepath.Join(dir, "empty.dat")); err != nil || st.Size() != 0 {
		t.Errorf("empty.dat did not survive: %v", err)
	}
	gotBin, err := os.ReadFile(filepath.Join(dir, "blob.bin"))
	if err != nil {
		t.Fatalf("blob.bin: %v", err)
	}
	if !bytes.Equal(gotBin, binary) {
		t.Error("binary file did not survive the round trip")
	}
}

// The point of the length prefix: nothing inside a body is ever searched for,
// so a payload that looks like framing is still just bytes.
func TestStreamCarriesAdversarialBodies(t *testing.T) {
	tests := []struct {
		name    string
		content []byte
	}{
		{"body that is itself a header line", []byte(`{"name":"evil.sh","size":999}` + "\n")},
		{"many newlines", bytes.Repeat([]byte("line\n"), 500)},
		{"null bytes", bytes.Repeat([]byte{0x00, 0xff, 0x00}, 400)},
		{"json document", []byte(`{"a":[1,2,3],"b":{"c":"}\n{"}}`)},
		{"a real zip", zipBytes(t)},
		{"lone newline", []byte("\n")},
		{"no trailing newline", []byte("abc")},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			src := sourceFor(t, "payload.bin", tc.content)
			dir, written := roundTrip(t, []FileSource{src})

			if len(written) != 1 {
				t.Fatalf("wrote %d files, want 1", len(written))
			}
			got, err := os.ReadFile(filepath.Join(dir, "payload.bin"))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, tc.content) {
				t.Errorf("body was altered in transit: got %d bytes, want %d",
					len(got), len(tc.content))
			}
		})
	}
}

// A body that looks like a frame must not desynchronise the file after it.
func TestFramingSurvivesABodyThatLooksLikeAHeader(t *testing.T) {
	sneaky := sourceFor(t, "first.bin", []byte(`{"name":"planted.txt","size":5}`+"\nBOOM!"))
	real := sourceFor(t, "second.txt", []byte("genuine"))

	dir, written := roundTrip(t, []FileSource{sneaky, real})

	if len(written) != 2 {
		t.Fatalf("wrote %d files, want exactly 2 — a body was parsed as framing", len(written))
	}
	if _, err := os.Stat(filepath.Join(dir, "planted.txt")); err == nil {
		t.Error("a file named inside a body was created")
	}
	got, _ := os.ReadFile(filepath.Join(dir, "second.txt"))
	if string(got) != "genuine" {
		t.Errorf("the file after the sneaky one arrived as %q", got)
	}
}

func TestReceivedFilesAreNotExecutable(t *testing.T) {
	// An .apk or a .sh must land as data, whatever it claims to be.
	src := sourceFor(t, "app-release.apk", []byte("PK\x03\x04not really"))
	dir, written := roundTrip(t, []FileSource{src})

	st, err := os.Stat(written[0])
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm()&0o111 != 0 {
		t.Errorf("mode = %v, want no execute bit", st.Mode().Perm())
	}
	if filepath.Ext(written[0]) != ".apk" {
		t.Errorf("extension was not preserved: %q", written[0])
	}
	_ = dir
}

func TestReceiveSanitisesHostileNames(t *testing.T) {
	src := sourceFor(t, "ok.txt", []byte("data"))
	// The sender's own name is bypassed: this is what a hostile peer would put
	// on the wire, and ReadFiles must sanitise it again rather than trust it.
	src.Name = "../../escaped.txt"

	dir, written := roundTrip(t, []FileSource{src})
	if filepath.Dir(written[0]) != dir {
		t.Errorf("wrote to %q, want inside %q", written[0], dir)
	}
}

func TestReceiveNeverOverwrites(t *testing.T) {
	dst := t.TempDir()
	if err := os.WriteFile(filepath.Join(dst, "a.txt"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}

	src := sourceFor(t, "a.txt", []byte("theirs"))
	var wire bytes.Buffer
	if err := WriteFiles(&wire, []FileSource{src}, nil); err != nil {
		t.Fatal(err)
	}
	written, err := ReadFiles(bufio.NewReader(&wire), dst, MaxTotalBytes, nil)
	if err != nil {
		t.Fatalf("ReadFiles: %v", err)
	}

	if filepath.Base(written[0]) != "a (2).txt" {
		t.Errorf("wrote %q, want a (2).txt", filepath.Base(written[0]))
	}
	mine, _ := os.ReadFile(filepath.Join(dst, "a.txt"))
	if string(mine) != "mine" {
		t.Errorf("existing file was clobbered: %q", mine)
	}
}

// A transfer cut off mid-file must leave nothing that looks complete.
func TestInterruptedTransferLeavesNoPartial(t *testing.T) {
	content := bytes.Repeat([]byte("x"), 4*copyBufSize)
	src := sourceFor(t, "big.bin", content)

	var wire bytes.Buffer
	if err := WriteFiles(&wire, []FileSource{src}, nil); err != nil {
		t.Fatal(err)
	}

	// Truncate the stream part way through the body.
	full := wire.Bytes()
	cut := bytes.NewReader(full[:len(full)/2])

	dst := t.TempDir()
	written, err := ReadFiles(bufio.NewReader(cut), dst, MaxTotalBytes, nil)
	if err == nil {
		t.Fatal("a truncated stream was accepted")
	}
	if len(written) != 0 {
		t.Errorf("reported %d files written from a truncated stream", len(written))
	}

	entries, _ := os.ReadDir(dst)
	for _, e := range entries {
		t.Errorf("left behind %q — a partial transfer should clean up", e.Name())
	}
}

func TestReadFilesRejectsMoreThanWasOffered(t *testing.T) {
	src := sourceFor(t, "a.bin", bytes.Repeat([]byte("y"), 4096))

	var wire bytes.Buffer
	if err := WriteFiles(&wire, []FileSource{src}, nil); err != nil {
		t.Fatal(err)
	}

	// The offer said 100 bytes; the stream carries far more.
	_, err := ReadFiles(bufio.NewReader(&wire), t.TempDir(), 100, nil)
	if err == nil {
		t.Fatal("a stream larger than the offer was accepted")
	}
}

func TestReadFilesRejectsAGarbageHeader(t *testing.T) {
	for _, body := range []string{"not json\n", "{}\n", `{"name":"","size":5}` + "\n"} {
		_, err := ReadFiles(bufio.NewReader(strings.NewReader(body)), t.TempDir(), MaxTotalBytes, nil)
		if err == nil {
			t.Errorf("accepted a garbage header: %q", body)
		}
	}
}

// A header line that never ends must not make us buffer without limit.
func TestReadFilesRejectsAnEndlessHeader(t *testing.T) {
	endless := strings.NewReader(`{"name":"` + strings.Repeat("a", 2*maxHeaderLen))
	if _, err := ReadFiles(bufio.NewReader(endless), t.TempDir(), MaxTotalBytes, nil); err == nil {
		t.Error("accepted an unterminated header")
	}
}

func TestProgressIsMonotonicAndComplete(t *testing.T) {
	content := bytes.Repeat([]byte("z"), 5*copyBufSize+9)
	src := sourceFor(t, "big.bin", content)

	var sent []int64
	var wire bytes.Buffer
	if err := WriteFiles(&wire, []FileSource{src}, func(n int64) { sent = append(sent, n) }); err != nil {
		t.Fatal(err)
	}

	if len(sent) < 2 {
		t.Fatalf("progress fired %d times, want several", len(sent))
	}
	for i := 1; i < len(sent); i++ {
		if sent[i] < sent[i-1] {
			t.Fatalf("progress went backwards: %d then %d", sent[i-1], sent[i])
		}
	}
	if got := sent[len(sent)-1]; got != int64(len(content)) {
		t.Errorf("final progress = %d, want %d", got, len(content))
	}

	var got []int64
	if _, err := ReadFiles(bufio.NewReader(&wire), t.TempDir(), MaxTotalBytes,
		func(n int64) { got = append(got, n) }); err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 || got[len(got)-1] != int64(len(content)) {
		t.Errorf("receive progress ended at %v, want %d", got, len(content))
	}
}

// zipBytes builds a small real zip archive, so the adversarial-body test is
// exercising an actual compressed container rather than a guess at one.
func zipBytes(t *testing.T) []byte {
	t.Helper()

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("inner.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("contents\nwith\nnewlines\n")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
