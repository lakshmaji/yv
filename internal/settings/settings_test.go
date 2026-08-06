package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"yv/internal/models"
)

func TestNormalize(t *testing.T) {
	all := DefaultPanels

	tests := []struct {
		name string
		in   models.Settings
		want models.Settings
	}{
		{
			name: "zero value gets every default",
			in:   models.Settings{},
			want: models.Settings{SchemaVersion: 1, MetricsEnabled: false, RetentionDays: 365, Panels: all},
		},
		{
			name: "negative retention falls back to default",
			in:   models.Settings{RetentionDays: -5},
			want: models.Settings{SchemaVersion: 1, RetentionDays: 365, Panels: all},
		},
		{
			name: "retention above the cap is clamped",
			in:   models.Settings{RetentionDays: 5000},
			want: models.Settings{SchemaVersion: 1, RetentionDays: MaxRetentionDays, Panels: all},
		},
		{
			name: "in-range retention is preserved",
			in:   models.Settings{RetentionDays: 30},
			want: models.Settings{SchemaVersion: 1, RetentionDays: 30, Panels: all},
		},
		{
			name: "enabled flag is preserved",
			in:   models.Settings{MetricsEnabled: true, RetentionDays: 7},
			want: models.Settings{SchemaVersion: 1, MetricsEnabled: true, RetentionDays: 7, Panels: all},
		},
		{
			name: "stale schema version is upgraded",
			in:   models.Settings{SchemaVersion: 0, RetentionDays: 90},
			want: models.Settings{SchemaVersion: 1, RetentionDays: 90, Panels: all},
		},
		{
			name: "panel subset survives",
			in:   models.Settings{Panels: []string{PanelActivity}},
			want: models.Settings{SchemaVersion: 1, RetentionDays: 365, Panels: []string{PanelActivity}},
		},
		{
			name: "audio clips keep their order",
			in:   models.Settings{AudioClips: []string{"/b.mp3", "/a.wav"}},
			want: models.Settings{SchemaVersion: 1, RetentionDays: 365, Panels: all, AudioClips: []string{"/b.mp3", "/a.wav"}},
		},
		{
			name: "duplicate and unsupported clips are dropped",
			in:   models.Settings{AudioClips: []string{"/a.mp3", "/a.mp3", "/notes.txt"}},
			want: models.Settings{SchemaVersion: 1, RetentionDays: 365, Panels: all, AudioClips: []string{"/a.mp3"}},
		},
		{
			name: "an all-invalid clip list normalises away",
			in:   models.Settings{AudioClips: []string{"/notes.txt"}},
			want: models.Settings{SchemaVersion: 1, RetentionDays: 365, Panels: all},
		},
		{
			name: "sound is audible by default and mute is preserved",
			in:   models.Settings{SoundMuted: true},
			want: models.Settings{SchemaVersion: 1, RetentionDays: 365, Panels: all, SoundMuted: true},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Normalize(tt.in)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Normalize() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestNormalizePanels(t *testing.T) {
	tests := []struct {
		name string
		in   []string
		want []string
	}{
		{"nil means all", nil, DefaultPanels},
		{"empty means all", []string{}, DefaultPanels},
		{"only unknown means all", []string{"nope", "bogus"}, DefaultPanels},
		{"unknown entries are dropped", []string{PanelMemory, "nope"}, []string{PanelMemory}},
		{"duplicates collapse", []string{PanelFrequency, PanelFrequency}, []string{PanelFrequency}},
		{
			name: "order is canonical, not input order",
			in:   []string{PanelActivity, PanelStats, PanelMemory},
			want: []string{PanelStats, PanelMemory, PanelActivity},
		},
		{"single panel is respected", []string{PanelStats}, []string{PanelStats}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := NormalizePanels(tt.in)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("NormalizePanels(%v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name    string
		in      models.Settings
		wantErr bool
	}{
		{"zero value is valid", models.Settings{}, false},
		{"minimum retention", models.Settings{RetentionDays: MinRetentionDays}, false},
		{"maximum retention", models.Settings{RetentionDays: MaxRetentionDays}, false},
		{"below minimum", models.Settings{RetentionDays: -1}, true},
		{"above maximum", models.Settings{RetentionDays: MaxRetentionDays + 1}, true},
		{"known panels", models.Settings{Panels: DefaultPanels}, false},
		{"unknown panel", models.Settings{Panels: []string{"drop-tables"}}, true},
		{"empty panels", models.Settings{Panels: []string{}}, false},
		{"supported clips", models.Settings{AudioClips: []string{"/roar.mp3", "/growl.wav"}}, false},
		{"unsupported clip", models.Settings{AudioClips: []string{"/roar.aiff"}}, true},
		{"no clips", models.Settings{AudioClips: nil}, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := Validate(tt.in)
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// --- store tests (isolated via HOME, as in internal/env) ---

func TestStoreDefaultsWhenMissing(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	got := NewStore().Get()
	if got.MetricsEnabled {
		t.Error("metrics should be OFF by default")
	}
	if got.RetentionDays != DefaultRetentionDays {
		t.Errorf("RetentionDays = %d, want %d", got.RetentionDays, DefaultRetentionDays)
	}
	if !reflect.DeepEqual(got.Panels, DefaultPanels) {
		t.Errorf("Panels = %v, want %v", got.Panels, DefaultPanels)
	}
	if got.SoundMuted {
		t.Error("sound should be audible by default")
	}
	if len(got.AudioClips) != 0 {
		t.Errorf("AudioClips = %v, want none — no audio ships with the app", got.AudioClips)
	}
}

func TestStoreRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	s := NewStore()
	if _, err := s.Save(models.Settings{
		MetricsEnabled: true,
		RetentionDays:  30,
		Panels:         []string{PanelMemory},
		SoundMuted:     true,
		AudioClips:     []string{"/clips/roar.mp3"},
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// A fresh store must see the same values from disk.
	got := NewStore().Get()
	if !got.MetricsEnabled {
		t.Error("MetricsEnabled did not persist")
	}
	if got.RetentionDays != 30 {
		t.Errorf("RetentionDays = %d, want 30", got.RetentionDays)
	}
	if !reflect.DeepEqual(got.Panels, []string{PanelMemory}) {
		t.Errorf("Panels = %v, want [memory]", got.Panels)
	}
	if !got.SoundMuted {
		t.Error("SoundMuted did not persist")
	}
	if !reflect.DeepEqual(got.AudioClips, []string{"/clips/roar.mp3"}) {
		t.Errorf("AudioClips = %v, want [/clips/roar.mp3]", got.AudioClips)
	}
}

func TestStoreDefaultsWhenCorrupt(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	path, err := storePath()
	if err != nil {
		t.Fatalf("storePath: %v", err)
	}
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got := NewStore().Get()
	if got.RetentionDays != DefaultRetentionDays || got.MetricsEnabled {
		t.Errorf("corrupt file should yield defaults, got %+v", got)
	}
}

func TestUnknownFieldsIgnored(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	path, _ := storePath()
	raw := `{"schemaVersion":1,"metricsEnabled":true,"retentionDays":45,"futureSetting":"hello"}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got := NewStore().Get()
	if !got.MetricsEnabled || got.RetentionDays != 45 {
		t.Errorf("known fields should survive an unknown one, got %+v", got)
	}
}

func TestStoreFileIsOwnerOnly(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	s := NewStore()
	if _, err := s.Save(models.Settings{RetentionDays: 10}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	path, _ := storePath()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("settings file mode = %o, want 600", perm)
	}
}

func TestHotPathMirrors(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	s := NewStore()
	if s.MetricsEnabled() {
		t.Error("MetricsEnabled() should start false")
	}
	if s.RetentionDays() != DefaultRetentionDays {
		t.Errorf("RetentionDays() = %d, want %d", s.RetentionDays(), DefaultRetentionDays)
	}

	if _, err := s.Save(models.Settings{MetricsEnabled: true, RetentionDays: 7}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if !s.MetricsEnabled() {
		t.Error("MetricsEnabled() must reflect Save immediately")
	}
	if s.RetentionDays() != 7 {
		t.Errorf("RetentionDays() = %d, want 7", s.RetentionDays())
	}

	// A store constructed afterwards primes its mirrors from disk.
	if fresh := NewStore(); !fresh.MetricsEnabled() || fresh.RetentionDays() != 7 {
		t.Error("NewStore did not prime mirrors from disk")
	}
}

func TestSaveRejectsInvalidWithoutWriting(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	s := NewStore()
	if _, err := s.Save(models.Settings{RetentionDays: 99999}); err == nil {
		t.Fatal("expected an error for out-of-range retention")
	}

	path, _ := storePath()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("an invalid Save must not create the settings file")
	}
}

func TestOnChangeFires(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	s := NewStore()
	var seen []models.Settings
	s.OnChange(func(cur models.Settings) { seen = append(seen, cur) })

	if _, err := s.Save(models.Settings{MetricsEnabled: true}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if len(seen) != 1 {
		t.Fatalf("observer called %d times, want 1", len(seen))
	}
	if !seen[0].MetricsEnabled {
		t.Error("observer received stale settings")
	}
	if seen[0].RetentionDays != DefaultRetentionDays {
		t.Error("observer should receive normalized settings")
	}
}

func TestSavedFileIsValidJSON(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	s := NewStore()
	if _, err := s.Save(models.Settings{MetricsEnabled: true, RetentionDays: 20}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	path, _ := storePath()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var round models.Settings
	if err := json.Unmarshal(raw, &round); err != nil {
		t.Fatalf("saved file is not valid JSON: %v", err)
	}
	if round.RetentionDays != 20 {
		t.Errorf("round-tripped RetentionDays = %d, want 20", round.RetentionDays)
	}
	if filepath.Base(path) != fileName {
		t.Errorf("unexpected file name %q", filepath.Base(path))
	}
}

func TestValidateSharePIN(t *testing.T) {
	tests := []struct {
		name string
		pin  string
		ok   bool
	}{
		{"empty means no PIN", "", true},
		{"whitespace is treated as empty", "   ", true},
		{"four digits is the minimum", "1234", true},
		{"twelve digits is the maximum", "123456789012", true},
		{"surrounding space is tolerated", " 1234 ", true},
		{"three digits is too short", "123", false},
		{"thirteen digits is too long", "1234567890123", false},
		{"letters are rejected", "12ab", false},
		{"punctuation is rejected", "12-34", false},
		{"inner space is rejected", "12 34", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateSharePIN(tc.pin)
			if tc.ok && err != nil {
				t.Errorf("ValidateSharePIN(%q) = %v, want nil", tc.pin, err)
			}
			if !tc.ok && err == nil {
				t.Errorf("ValidateSharePIN(%q) = nil, want an error", tc.pin)
			}
		})
	}
}

func TestNormalizeTrimsSharePIN(t *testing.T) {
	got := Normalize(models.Settings{SharePIN: "  4829  "})
	if got.SharePIN != "4829" {
		t.Errorf("SharePIN = %q, want %q", got.SharePIN, "4829")
	}
}

// The zero value has to keep meaning "no PIN", or an older settings file would
// suddenly require one.
func TestZeroSettingsHasNoSharePIN(t *testing.T) {
	if got := Normalize(models.Settings{}); got.SharePIN != "" {
		t.Errorf("SharePIN = %q, want empty for zero settings", got.SharePIN)
	}
}
