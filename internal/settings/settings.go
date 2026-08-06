// Package settings stores global, app-wide preferences — the metrics opt-in,
// its retention window, and which dashboard panels are visible.
//
// Settings live in their own file, separate from projects.json, because they
// describe the app rather than any project and must never travel with an
// exported project. The file is written with 0600 permissions.
//
// The subset of settings read on hot paths (metrics enabled/retention) is
// mirrored into atomics so the 3-second monitor tick and every command
// completion can consult them without a disk read or a mutex acquisition.
package settings

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"

	"yv/internal/audio"
	"yv/internal/models"
)

// fileName is the settings file inside the app config dir.
const fileName = "settings.json"

const (
	// DefaultRetentionDays is how long collected metrics are kept when the
	// user has not chosen otherwise.
	DefaultRetentionDays = 365
	MinRetentionDays     = 1
	MaxRetentionDays     = 3650

	schemaVersion = 1
)

// Panel IDs. These are the dashboard sections the user can show or hide.
const (
	PanelStats     = "stats"
	PanelMemory    = "memory"
	PanelFrequency = "frequency"
	PanelActivity  = "activity"
)

// DefaultPanels is the panel set applied when none has been chosen. Order here
// is the canonical render order; the stored list does not control ordering.
var DefaultPanels = []string{PanelStats, PanelMemory, PanelFrequency, PanelActivity}

// knownPanels is the set DefaultPanels is drawn from, used to reject stale or
// hand-edited IDs.
var knownPanels = map[string]bool{
	PanelStats:     true,
	PanelMemory:    true,
	PanelFrequency: true,
	PanelActivity:  true,
}

// Store is a file-backed global settings store. A mutex serialises
// read-modify-write cycles; the atomics are a lock-free mirror for hot paths.
type Store struct {
	mu sync.Mutex

	enabled   atomic.Bool
	retention atomic.Int64

	obsMu     sync.Mutex
	observers []func(models.Settings)
}

// NewStore reads the settings file once and primes the hot-path mirrors.
func NewStore() *Store {
	s := &Store{}
	cur := Normalize(s.load())
	s.enabled.Store(cur.MetricsEnabled)
	s.retention.Store(int64(cur.RetentionDays))
	return s
}

// Get returns the current settings with defaults applied.
func (s *Store) Get() models.Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Normalize(s.load())
}

// Save validates, normalises, and persists the settings, then updates the
// hot-path mirrors and notifies observers. The mirrors are updated before the
// lock is released, so by the time Save returns a disabled collector has
// already stopped.
func (s *Store) Save(in models.Settings) (models.Settings, error) {
	if err := Validate(in); err != nil {
		return models.Settings{}, err
	}

	next := Normalize(in)

	s.mu.Lock()
	if err := s.write(next); err != nil {
		s.mu.Unlock()
		return models.Settings{}, err
	}
	s.enabled.Store(next.MetricsEnabled)
	s.retention.Store(int64(next.RetentionDays))
	s.mu.Unlock()

	s.notify(next)
	return next, nil
}

// MetricsEnabled reports whether metrics collection is on. Safe and cheap to
// call from any goroutine — it never touches the disk or the mutex.
func (s *Store) MetricsEnabled() bool { return s.enabled.Load() }

// RetentionDays returns the configured retention window in days.
func (s *Store) RetentionDays() int { return int(s.retention.Load()) }

// OnChange registers a callback fired after every successful Save.
func (s *Store) OnChange(fn func(models.Settings)) {
	if fn == nil {
		return
	}
	s.obsMu.Lock()
	s.observers = append(s.observers, fn)
	s.obsMu.Unlock()
}

func (s *Store) notify(cur models.Settings) {
	s.obsMu.Lock()
	fns := make([]func(models.Settings), len(s.observers))
	copy(fns, s.observers)
	s.obsMu.Unlock()

	for _, fn := range fns {
		fn(cur)
	}
}

// load reads the settings file. Any failure yields a zero Settings, which
// Normalize turns into the defaults — settings are a convenience, never a
// hard dependency. Callers must hold s.mu.
func (s *Store) load() models.Settings {
	path, err := storePath()
	if err != nil {
		return models.Settings{}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return models.Settings{}
	}
	var cur models.Settings
	if err := json.Unmarshal(raw, &cur); err != nil {
		return models.Settings{}
	}
	return cur
}

// write persists the settings with owner-only permissions.
// Callers must hold s.mu.
func (s *Store) write(cur models.Settings) error {
	path, err := storePath()
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cur, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o600)
}

func storePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("UserConfigDir: %w", err)
	}
	appDir := filepath.Join(dir, "yv")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		return "", fmt.Errorf("MkdirAll: %w", err)
	}
	return filepath.Join(appDir, fileName), nil
}

// --- pure helpers (unit tested) ---

// Normalize fills in defaults and clamps out-of-range values. Every zero value
// means "default", which is what lets a file written by an older build be read
// without migration.
func Normalize(in models.Settings) models.Settings {
	out := in
	out.SchemaVersion = schemaVersion

	if out.RetentionDays <= 0 {
		out.RetentionDays = DefaultRetentionDays
	}
	if out.RetentionDays < MinRetentionDays {
		out.RetentionDays = MinRetentionDays
	}
	if out.RetentionDays > MaxRetentionDays {
		out.RetentionDays = MaxRetentionDays
	}

	out.Panels = NormalizePanels(out.Panels)
	out.AudioClips = audio.NormalizePaths(out.AudioClips)
	return out
}

// NormalizePanels drops unknown and duplicate panel IDs and returns them in the
// canonical DefaultPanels order. An empty result falls back to every panel, so
// a stale config can never leave the dashboard blank.
func NormalizePanels(panels []string) []string {
	if panels == nil {
		return append([]string(nil), DefaultPanels...)
	}

	seen := make(map[string]bool, len(panels))
	for _, p := range panels {
		if knownPanels[p] {
			seen[p] = true
		}
	}
	if len(seen) == 0 {
		return append([]string(nil), DefaultPanels...)
	}

	out := make([]string, 0, len(seen))
	for _, p := range DefaultPanels {
		if seen[p] {
			out = append(out, p)
		}
	}
	return out
}

// Validate rejects values a user could type that Normalize would silently
// rewrite. Retention outside the supported range is an error rather than a
// clamp so the UI can explain it.
func Validate(in models.Settings) error {
	if in.RetentionDays != 0 && (in.RetentionDays < MinRetentionDays || in.RetentionDays > MaxRetentionDays) {
		return fmt.Errorf("retention must be between %d and %d days", MinRetentionDays, MaxRetentionDays)
	}
	unknown := make([]string, 0)
	for _, p := range in.Panels {
		if !knownPanels[p] {
			unknown = append(unknown, p)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return fmt.Errorf("unknown panel(s): %v", unknown)
	}
	return audio.ValidatePaths(in.AudioClips)
}
