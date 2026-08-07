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
	"strings"
	"sync"
	"sync/atomic"
	"unicode"

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

	// MaxVariantIDLen bounds a stored drone variant id. Slugs, not prose.
	MaxVariantIDLen = 32

	// MaxUsernameLen bounds the display name sent to nearby peers. It is drawn
	// under a dinosaur and read aloud over a desk, not written in a form.
	MaxUsernameLen = 32

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

	out.Username = NormalizeUsername(out.Username)
	out.Panels = NormalizePanels(out.Panels)
	out.AudioClips = audio.NormalizePaths(out.AudioClips)
	out.DroneVariant = strings.TrimSpace(out.DroneVariant)
	out.DroneFanClip = strings.TrimSpace(out.DroneFanClip)
	out.DroneCrashClip = strings.TrimSpace(out.DroneCrashClip)
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
	if err := ValidateUsername(in.Username); err != nil {
		return err
	}
	if err := ValidateDroneVariant(in.DroneVariant); err != nil {
		return err
	}
	// The drone's own clips are audio paths like any other, so they answer to the
	// same extension allowlist as the roars rather than a rule of their own.
	for _, clip := range []string{in.DroneFanClip, in.DroneCrashClip} {
		if clip == "" {
			continue
		}
		if err := audio.ValidatePaths([]string{clip}); err != nil {
			return err
		}
	}
	return audio.ValidatePaths(in.AudioClips)
}

// NormalizeUsername trims a stored name and strips the control characters that
// would otherwise reach a peer's screen. Normalising rather than rejecting
// whitespace matters because the empty result is meaningful: it is what makes
// the name optional, and it sends the device back to its hostname.
func NormalizeUsername(name string) string {
	name = strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return ' '
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	return strings.TrimSpace(strings.Join(strings.Fields(name), " "))
}

// ValidateUsername accepts an empty name — the default, meaning the hostname —
// or one short enough to sit under a dinosaur. Length is measured in runes:
// bounding bytes would cut a name of emoji or CJK characters at a third of the
// characters the user can see.
func ValidateUsername(name string) error {
	if len([]rune(NormalizeUsername(name))) > MaxUsernameLen {
		return fmt.Errorf("name must be at most %d characters", MaxUsernameLen)
	}
	return nil
}

// ValidateDroneVariant accepts an empty id — the default — or a short slug.
//
// The list of airframes lives in the frontend, because a variant is a drawing;
// duplicating it here would give two places to add a drone and one of them would
// be forgotten. So this checks only the shape of the id, and the frontend falls
// back to the default for anything it does not recognise.
func ValidateDroneVariant(id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	if len(id) > MaxVariantIDLen {
		return fmt.Errorf("drone variant id must be at most %d characters", MaxVariantIDLen)
	}
	for _, r := range id {
		lower := r >= 'a' && r <= 'z'
		digit := r >= '0' && r <= '9'
		if !lower && !digit && r != '-' {
			return fmt.Errorf("drone variant id must be lowercase letters, digits or dashes")
		}
	}
	return nil
}
