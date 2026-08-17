package config

import (
	"encoding/json"
	"os"
	"path/filepath"

	"yv/internal/atomicfile"
	"yv/internal/models"
)

// seenFileName records which config files the user has already been asked
// about, as path -> content hash.
//
// Without it the background scan re-offers the same eighteen files every four
// hours, and a restart re-offers everything the user has ever declined. Keying
// on the hash rather than the path alone means an edited file is offered again,
// which is right: the file did change.
const seenFileName = "scan-seen.json"

// This is nag suppression, not state anything depends on. Losing it costs one
// extra prompt, so every failure here is swallowed rather than surfaced —
// there is nothing a user could usefully do about it.
func seenPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	appDir := filepath.Join(dir, "yv")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		return "", err
	}
	return filepath.Join(appDir, seenFileName), nil
}

func loadSeen() map[string]string {
	path, err := seenPath()
	if err != nil {
		return map[string]string{}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]string{}
	}
	var seen map[string]string
	if err := json.Unmarshal(raw, &seen); err != nil || seen == nil {
		return map[string]string{}
	}
	return seen
}

// UnseenHits keeps only the hits worth interrupting the user for: a path never
// asked about, or one whose contents have changed since it was.
//
// A file that failed to parse is hashed and marked like any other, so it is
// reported once and then falls silent until its contents change — at which
// point the user hears about it again, which is what they want if someone has
// just fixed it. The alternative, re-reporting a broken file forever, is a nag
// the user often cannot end: the file may be in a repository they do not own.
//
// The exception is a hit with no hash at all, which is a file that could not be
// read rather than one that could not be parsed. Those keep being offered,
// because the cause is usually transient.
func (s *Store) UnseenHits(hits []models.ScanHit) []models.ScanHit {
	seen := loadSeen()
	out := make([]models.ScanHit, 0, len(hits))
	for _, h := range hits {
		if h.Hash != "" && seen[h.Path] == h.Hash {
			continue
		}
		out = append(out, h)
	}
	return out
}

// MarkSeen records hits the user has answered for — whether they imported them
// or left them unticked. Declining is an answer, and re-asking every four hours
// is how a prompt stops being read.
//
// Only called when the dialog was actually answered; dismissing it without
// deciding marks nothing, so the prompt returns.
func (s *Store) MarkSeen(hits []models.ScanHit) {
	if len(hits) == 0 {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	seen := loadSeen()
	changed := false
	for _, h := range hits {
		if h.Hash == "" || seen[h.Path] == h.Hash {
			continue
		}
		seen[h.Path] = h.Hash
		changed = true
	}
	if !changed {
		return
	}

	// A file deleted from disk keeps its entry, which costs one map key and
	// avoids a scan of the filesystem to prune it. If it ever comes back with
	// the same contents, not re-asking is the correct behaviour anyway.
	path, err := seenPath()
	if err != nil {
		return
	}
	raw, err := json.MarshalIndent(seen, "", "  ")
	if err != nil {
		return
	}
	_ = atomicfile.Write(path, raw, 0o644)
}
