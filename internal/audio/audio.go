// Package audio loads user-supplied sound clips for the webview.
//
// The clips live wherever the user keeps them, outside the app bundle, so the
// Wails asset server cannot reach them — it serves the embedded frontend and
// nothing else, and a file:// URL from an arbitrary directory is blocked. Load
// therefore reads the file here and hands the frontend a data URL, which an
// <audio> element accepts directly.
//
// No audio ships with the app. Everything in a user's pool is a path they chose
// in Settings, which is why paths are validated on the way in (extension, size,
// regular file) rather than trusted.
package audio

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// MaxClipBytes caps a single clip. The file is base64-encoded into a string that
// crosses the Wails bridge and is then held in a JS Map for the session, so the
// real cost is roughly 1.4x this per distinct clip played. 15 MB is far above any
// plausible roar and still bounded.
const MaxClipBytes int64 = 15 << 20

// mimeTypes maps the extensions the macOS WebKit webview can decode to the MIME
// type used in the data URL. Anything absent is rejected rather than guessed:
// handing the webview a clip it cannot decode fails silently at play() time,
// which is far harder to explain than "unsupported file".
var mimeTypes = map[string]string{
	".mp3":  "audio/mpeg",
	".m4a":  "audio/mp4",
	".aac":  "audio/aac",
	".wav":  "audio/wav",
	".ogg":  "audio/ogg",
	".flac": "audio/flac",
}

// SupportedExts returns the accepted extensions, sorted, for messages and for
// building the file-dialog filter.
func SupportedExts() []string {
	out := make([]string, 0, len(mimeTypes))
	for ext := range mimeTypes {
		out = append(out, ext)
	}
	sort.Strings(out)
	return out
}

// DialogPattern is the file-dialog filter pattern, e.g. "*.aac;*.flac;…".
func DialogPattern() string {
	exts := SupportedExts()
	for i, ext := range exts {
		exts[i] = "*" + ext
	}
	return strings.Join(exts, ";")
}

// MimeType returns the MIME type for a path's extension, or "" if the extension
// is not supported.
func MimeType(path string) string {
	return mimeTypes[strings.ToLower(filepath.Ext(path))]
}

// Load reads a clip and returns it as a data URL ready for an <audio> src.
func Load(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("no clip path given")
	}

	mime := MimeType(path)
	if mime == "" {
		return "", fmt.Errorf("unsupported audio file %q (expected one of %s)",
			filepath.Base(path), strings.Join(SupportedExts(), ", "))
	}

	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("cannot read %q: %w", filepath.Base(path), err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%q is not a file", filepath.Base(path))
	}
	if info.Size() > MaxClipBytes {
		return "", fmt.Errorf("%q is %d bytes; the limit is %d", filepath.Base(path), info.Size(), MaxClipBytes)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("cannot read %q: %w", filepath.Base(path), err)
	}

	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
}

// NormalizePaths drops blank, unsupported, and duplicate entries while keeping
// the order the user added them in. It deliberately does not check that the
// files still exist: a clip on an unmounted volume should stay in the list and
// fail at play time, not vanish from Settings.
func NormalizePaths(paths []string) []string {
	if len(paths) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(paths))
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" || MimeType(p) == "" || seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// ValidatePaths rejects what NormalizePaths would silently drop, so the UI can
// explain the refusal instead of a clip quietly disappearing on save.
func ValidatePaths(paths []string) error {
	bad := make([]string, 0)
	for _, p := range paths {
		if strings.TrimSpace(p) == "" {
			continue
		}
		if MimeType(p) == "" {
			bad = append(bad, filepath.Base(p))
		}
	}
	if len(bad) > 0 {
		return fmt.Errorf("unsupported audio file(s): %s (expected one of %s)",
			strings.Join(bad, ", "), strings.Join(SupportedExts(), ", "))
	}
	return nil
}
