package config

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"yv/internal/models"
)

// historyFileName is the import audit log: one JSON object per line, appended.
//
// Append-only, following internal/metrics: the write cost stays proportional to
// the new record rather than to the whole log, and a line truncated by a hard
// kill costs that one entry instead of corrupting every entry before it.
const historyFileName = "import-history.jsonl"

// maxHistoryLines bounds a read, not the file. At roughly 150 bytes a record
// even a decade of daily imports is under a megabyte, so there is nothing worth
// pruning; this only stops a hand-edited or runaway file from being pulled into
// memory whole.
const maxHistoryLines = 5000

func historyPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	appDir := filepath.Join(dir, "yv")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		return "", err
	}
	return filepath.Join(appDir, historyFileName), nil
}

// appendImports records what an import did.
//
// Best effort by design, and it never returns an error: a failed audit write
// must not fail — or appear to fail — an import that has already succeeded and
// been written to disk.
func appendImports(records []models.ImportRecord) {
	if len(records) == 0 {
		return
	}
	path, err := historyPath()
	if err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	w := bufio.NewWriter(f)
	for _, rec := range records {
		if rec.At == "" {
			rec.At = now
		}
		line, err := json.Marshal(rec)
		if err != nil {
			continue
		}
		w.Write(line)
		w.WriteByte('\n')
	}
	_ = w.Flush()
}

// GetImportHistory returns the most recent imports, newest first.
//
// A malformed line is skipped rather than failing the read: this is a log, and
// one bad entry must not hide the rest of the history.
func (s *Store) GetImportHistory(limit int) []models.ImportRecord {
	out := []models.ImportRecord{}
	if limit <= 0 {
		return out
	}

	path, err := historyPath()
	if err != nil {
		return out
	}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()

	// Read forwards keeping a sliding window of the last `limit` entries, so
	// memory is bounded by what is asked for rather than by the file's size.
	window := make([]models.ImportRecord, 0, limit)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for n := 0; sc.Scan() && n < maxHistoryLines; n++ {
		var rec models.ImportRecord
		if err := json.Unmarshal(sc.Bytes(), &rec); err != nil {
			continue
		}
		if len(window) == limit {
			window = window[1:]
		}
		window = append(window, rec)
	}

	for i := len(window) - 1; i >= 0; i-- {
		out = append(out, window[i])
	}
	return out
}
