package share

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

const (
	// MaxFileBytes caps one file.
	//
	// Files are streamed to disk rather than held in memory, so this bounds time
	// and disk rather than RAM — a transfer of any size costs one copyBufSize
	// buffer on each machine.
	MaxFileBytes int64 = 500 << 20 // 500 MB

	// MaxTotalBytes caps one transfer.
	MaxTotalBytes int64 = 1 << 30 // 1 GB

	// MaxFiles caps how many can go at once, so a picked folder's worth of tiny
	// files cannot make a transfer of a hundred thousand frames.
	MaxFiles = 64

	// ReceiveDirName is the folder received files are written into.
	ReceiveDirName = "yv-received"

	// copyBufSize is the whole memory cost of a transfer, per side.
	copyBufSize = 32 << 10 // 32 KB

	// partSuffix marks a file that has not finished arriving. It is renamed into
	// place only once the last byte is written, so an interrupted transfer never
	// leaves something that looks complete.
	partSuffix = ".part"

	// maxHeaderLen bounds one file header line. Generous for a name and a size,
	// small enough that a peer cannot make us buffer without limit looking for a
	// newline that never comes.
	maxHeaderLen = 8 << 10
)

// FileSource is a local file queued for sending: what to call it on the wire,
// how big it is, and where to read it from.
//
// Deliberately not the contents. The size is read by StatFiles up front so the
// offer can describe the transfer, and the bytes are only opened at the moment
// they are streamed.
type FileSource struct {
	Name string
	Size int64
	Path string
}

// fileHeader precedes each file's bytes on the wire.
//
// This is the only structured thing in the stream. The body that follows is
// opaque — an .apk, a .zip, a video — and is copied verbatim, so Size is what
// tells the reader where it ends. Nothing inside a body is ever parsed or
// searched, which is what makes arbitrary binary safe to carry.
type fileHeader struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// StatFiles validates the picked paths and records what it will take to send
// them. Nothing is read.
//
// Reading is deferred deliberately: a transfer refused for size must not first
// spend time and memory loading files that are about to be rejected. A
// directory is an error rather than a silent skip — the user picked it, and
// quietly sending nothing is worse than saying no.
func StatFiles(paths []string) ([]FileSource, error) {
	if len(paths) == 0 {
		return nil, fmt.Errorf("no files chosen")
	}
	if len(paths) > MaxFiles {
		return nil, fmt.Errorf("too many files — %d at most", MaxFiles)
	}

	out := make([]FileSource, 0, len(paths))
	var total int64

	for _, p := range paths {
		st, err := os.Stat(p)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", filepath.Base(p), err)
		}
		if st.IsDir() {
			return nil, fmt.Errorf("%s is a folder — pick files", filepath.Base(p))
		}
		if st.Size() > MaxFileBytes {
			return nil, fmt.Errorf("%s is %s — %s at most per file",
				filepath.Base(p), HumanSize(st.Size()), HumanSize(MaxFileBytes))
		}
		total += st.Size()
		if total > MaxTotalBytes {
			return nil, fmt.Errorf("that is more than %s — too much for one transfer",
				HumanSize(MaxTotalBytes))
		}
		out = append(out, FileSource{
			Name: SafeName(filepath.Base(p)),
			Size: st.Size(),
			Path: p,
		})
	}
	return out, nil
}

// TotalBytes sums what a set of sources will put on the wire.
func TotalBytes(files []FileSource) int64 {
	var n int64
	for _, f := range files {
		n += f.Size
	}
	return n
}

// FileNames lists the names a set of sources will arrive under.
func FileNames(files []FileSource) []string {
	names := make([]string, 0, len(files))
	for _, f := range files {
		names = append(names, f.Name)
	}
	return names
}

// WriteFiles streams each file to w as a header line followed by exactly
// Size opaque bytes.
//
// onProgress is called with the running total after each chunk; it is expected
// to be cheap, since it fires once per copyBufSize.
//
// A file that changed size since StatFiles is an error rather than a short
// write: the header has already promised a byte count, and a stream that does
// not deliver it would desynchronise every frame after it.
func WriteFiles(w io.Writer, files []FileSource, onProgress func(int64)) error {
	buf := make([]byte, copyBufSize)
	var sent int64

	for _, f := range files {
		header, err := json.Marshal(fileHeader{Name: f.Name, Size: f.Size})
		if err != nil {
			return fmt.Errorf("header for %s: %w", f.Name, err)
		}
		if _, err := w.Write(append(header, '\n')); err != nil {
			return fmt.Errorf("send header for %s: %w", f.Name, err)
		}

		src, err := os.Open(f.Path)
		if err != nil {
			return fmt.Errorf("%s: %w", f.Name, err)
		}

		written, err := copyChunks(w, src, f.Size, buf, func(n int64) {
			if onProgress != nil {
				onProgress(sent + n)
			}
		})
		_ = src.Close()

		if err != nil {
			return fmt.Errorf("sending %s: %w", f.Name, err)
		}
		if written != f.Size {
			return fmt.Errorf("%s changed while it was being sent", f.Name)
		}
		sent += written
	}
	return nil
}

// ReadFiles streams frames from r into dir until EOF, and returns the paths
// written.
//
// r must be the same buffered reader used for the header line, or the JSON
// decoder would read past it and swallow the first bytes of the body.
//
// A failure part-way leaves nothing behind: the file being written is removed,
// and files already completed are reported so the caller can say what did
// arrive rather than implying none of it did.
func ReadFiles(br *bufio.Reader, dir string, limit int64, onProgress func(int64)) ([]string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create %s: %w", dir, err)
	}

	buf := make([]byte, copyBufSize)
	written := make([]string, 0, 4)
	var received int64

	for len(written) <= MaxFiles {
		header, err := readHeader(br)
		if err == io.EOF {
			return written, nil
		}
		if err != nil {
			return written, err
		}

		if header.Size < 0 || header.Size > MaxFileBytes {
			return written, fmt.Errorf("%s is larger than this device accepts", header.Name)
		}
		received += header.Size
		if received > limit {
			return written, fmt.Errorf("more data than the transfer offered")
		}

		path, err := receiveOne(br, dir, header, buf, received-header.Size, onProgress)
		if err != nil {
			return written, err
		}
		written = append(written, path)
	}
	return written, fmt.Errorf("more than %d files", MaxFiles)
}

// receiveOne writes a single frame's body to disk, via a .part file that is
// renamed only once every promised byte has arrived.
func receiveOne(br *bufio.Reader, dir string, header fileHeader, buf []byte, before int64, onProgress func(int64)) (string, error) {
	// Sanitised again rather than trusting the sender or an earlier pass: this
	// is the last step before a path is written.
	final := uniquePath(dir, SafeName(header.Name))
	part := final + partSuffix

	dst, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return "", fmt.Errorf("create %s: %w", filepath.Base(final), err)
	}

	got, err := copyChunks(dst, br, header.Size, buf, func(n int64) {
		if onProgress != nil {
			onProgress(before + n)
		}
	})
	closeErr := dst.Close()

	if err == nil && got != header.Size {
		err = fmt.Errorf("%s ended early", header.Name)
	}
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(part)
		return "", err
	}

	if err := os.Rename(part, final); err != nil {
		_ = os.Remove(part)
		return "", fmt.Errorf("finish %s: %w", filepath.Base(final), err)
	}
	// Best effort, and after the rename so the flag lands on the final name.
	// A file that arrived from another machine should face the same scrutiny as
	// one downloaded in a browser; failing to mark it is not worth losing the
	// transfer over.
	markQuarantine(final)
	return final, nil
}

// readHeader reads one newline-terminated header line.
func readHeader(br *bufio.Reader) (fileHeader, error) {
	var h fileHeader

	line, err := readLine(br, maxHeaderLen)
	if err != nil {
		return h, err
	}
	if err := json.Unmarshal(line, &h); err != nil {
		return h, fmt.Errorf("bad file header: %w", err)
	}
	if strings.TrimSpace(h.Name) == "" {
		return h, fmt.Errorf("file header with no name")
	}
	return h, nil
}

// readLine reads up to and including a newline, bounded by max.
//
// bufio.Reader.ReadString would grow without limit on a peer that never sends
// one, so the read is done in slices and counted.
func readLine(br *bufio.Reader, max int) ([]byte, error) {
	var out []byte
	for {
		chunk, err := br.ReadSlice('\n')
		out = append(out, chunk...)
		if err == nil {
			return out, nil
		}
		if err == bufio.ErrBufferFull {
			if len(out) > max {
				return nil, fmt.Errorf("file header too long")
			}
			continue
		}
		if err == io.EOF && len(out) == 0 {
			return nil, io.EOF
		}
		return nil, err
	}
}

// copyChunks copies exactly n bytes, reporting the running total as it goes.
//
// io.CopyN would do the copying, but it cannot report progress, and a 500 MB
// file with no sign of movement is indistinguishable from a hung one.
func copyChunks(dst io.Writer, src io.Reader, n int64, buf []byte, onProgress func(int64)) (int64, error) {
	var done int64
	for done < n {
		want := int64(len(buf))
		if remaining := n - done; remaining < want {
			want = remaining
		}

		read, rerr := src.Read(buf[:want])
		if read > 0 {
			if _, werr := dst.Write(buf[:read]); werr != nil {
				return done, werr
			}
			done += int64(read)
			if onProgress != nil {
				onProgress(done)
			}
		}
		if rerr == io.EOF {
			return done, nil
		}
		if rerr != nil {
			return done, rerr
		}
	}
	return done, nil
}

// SafeName reduces a name from another machine to something safe to join onto a
// directory.
//
// The name is treated as hostile: it decides a path we are about to write to.
// Separators (both kinds, since a Windows-shaped name can reach a Mac), the
// parent-directory entry, control characters and a leading dot are all removed,
// and an empty result becomes a placeholder rather than a path that resolves to
// the directory itself.
func SafeName(name string) string {
	name = strings.TrimSpace(name)
	name = strings.ReplaceAll(name, "\\", "/")
	// Both a path and a bare name reduce to the last segment.
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		if r == 0 || unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	// A leading dot would hide the file, which is the opposite of what a user
	// who just accepted a transfer expects to find.
	name = strings.TrimLeft(name, ".")
	name = strings.TrimSpace(name)

	if name == "" {
		return "received-file"
	}
	if len(name) > 120 {
		// Trim the stem, not the extension: the extension is what tells the
		// receiver's OS how to open it.
		ext := filepath.Ext(name)
		if len(ext) > 16 {
			ext = ""
		}
		name = name[:120-len(ext)] + ext
	}
	return name
}

// uniquePath finds a free name in dir, appending " (2)", " (3)" and so on before
// the extension. Bounded rather than looping forever: after 999 collisions the
// caller is better served by an error from the write than by a hung loop.
func uniquePath(dir, name string) string {
	path := filepath.Join(dir, name)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return path
	}

	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 2; i < 1000; i++ {
		p := filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, i, ext))
		if _, err := os.Stat(p); os.IsNotExist(err) {
			return p
		}
	}
	return path
}

// ReceiveDir is where received files land: ~/Downloads/yv-received when there is
// a Downloads folder, otherwise a folder beside the home directory.
//
// Downloads is chosen because it is where every other app puts things that
// arrived from elsewhere — a user looking for a file they just accepted will
// look there first, and it is not a directory anything of theirs depends on.
func ReceiveDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("home directory: %w", err)
	}
	downloads := filepath.Join(home, "Downloads")
	if st, err := os.Stat(downloads); err == nil && st.IsDir() {
		return filepath.Join(downloads, ReceiveDirName), nil
	}
	return filepath.Join(home, ReceiveDirName), nil
}

// HumanSize renders a byte count for a sentence, not a table — one decimal
// place, and none at all for whole bytes.
func HumanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit && exp < 3; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGT"[exp])
}
