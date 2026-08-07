package share

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"yv/internal/models"
)

const (
	// MaxFileBytes caps one file. The payload is held whole in memory on both
	// sides — read, base64'd into JSON, gzip'd, and decoded again — so this is a
	// memory bound, not a policy about what is worth sending.
	MaxFileBytes int64 = 32 << 20 // 32 MB

	// MaxTotalBytes caps one transfer. Same reasoning; four copies of 64 MB in
	// flight is already more than a desktop app should ask for.
	MaxTotalBytes int64 = 64 << 20 // 64 MB

	// MaxFiles caps how many can go at once, so a picked folder's worth of tiny
	// files cannot make a payload of a hundred thousand JSON objects.
	MaxFiles = 64

	// ReceiveDirName is the folder received files are written into.
	ReceiveDirName = "yv-received"
)

// PrepareFiles reads the picked paths into a payload.
//
// Everything is validated before anything is read, so a transfer that will be
// refused for size does not first spend a second loading files off disk. A
// directory is an error rather than a silent skip: the user picked it, and
// quietly sending nothing is worse than saying no.
func PrepareFiles(paths []string) ([]models.SharedFile, error) {
	if len(paths) == 0 {
		return nil, fmt.Errorf("no files chosen")
	}
	if len(paths) > MaxFiles {
		return nil, fmt.Errorf("too many files — %d at most", MaxFiles)
	}

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
	}
	if total > MaxTotalBytes {
		return nil, fmt.Errorf("that is %s — %s at most per transfer",
			HumanSize(total), HumanSize(MaxTotalBytes))
	}

	out := make([]models.SharedFile, 0, len(paths))
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", filepath.Base(p), err)
		}
		out = append(out, models.SharedFile{
			Name: SafeName(filepath.Base(p)),
			Size: int64(len(data)),
			Data: data,
		})
	}
	return out, nil
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

// SaveFiles writes received files into dir, creating it if needed.
//
// Returns the paths actually written, which differ from the offered names when
// a name was taken: an existing file is never overwritten, because the receiver
// agreed to accept a file, not to lose one.
func SaveFiles(dir string, files []models.SharedFile) ([]string, error) {
	if len(files) == 0 {
		return nil, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create %s: %w", dir, err)
	}

	written := make([]string, 0, len(files))
	for _, f := range files {
		path := uniquePath(dir, SafeName(f.Name))
		if err := os.WriteFile(path, f.Data, 0o644); err != nil {
			return written, fmt.Errorf("write %s: %w", filepath.Base(path), err)
		}
		written = append(written, path)
	}
	return written, nil
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
