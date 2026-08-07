package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"yv/internal/models"
)

// isolateHome points os.UserConfigDir at a scratch directory and returns it.
//
// Overriding HOME alone is not enough. On Linux os.UserConfigDir prefers
// XDG_CONFIG_HOME and only falls back to $HOME/.config — and GitHub's runners
// set XDG_CONFIG_HOME — so a HOME-only override silently reads and writes the
// real ~/.config/yv. Clearing it restores the $HOME fallback everywhere. On
// macOS the path is $HOME/Library/Application Support either way, which is why
// this only ever failed on Linux.
func isolateHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	return home
}

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
		{"no drone variant", models.Settings{DroneVariant: ""}, false},
		{"drone variant slug", models.Settings{DroneVariant: "hex-scout-2"}, false},
		{"drone variant with spaces", models.Settings{DroneVariant: "hex scout"}, true},
		{"supported fan clip", models.Settings{DroneFanClip: "/fan.mp3"}, false},
		{"unsupported fan clip", models.Settings{DroneFanClip: "/fan.aiff"}, true},
		{"no fan clip", models.Settings{DroneFanClip: ""}, false},
		{"supported crash clip", models.Settings{DroneCrashClip: "/boom.wav"}, false},
		{"unsupported crash clip", models.Settings{DroneCrashClip: "/boom.aiff"}, true},
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
	isolateHome(t)

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
	isolateHome(t)

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
	isolateHome(t)

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
	isolateHome(t)

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
	isolateHome(t)

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
	isolateHome(t)

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
	isolateHome(t)

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
	isolateHome(t)

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
	isolateHome(t)

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

func TestNormalizeUsername(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"left alone", "Lakshmaji", "Lakshmaji"},
		{"padded", "  Lakshmaji  ", "Lakshmaji"},
		{"empty stays empty, which is what makes it optional", "", ""},
		{"whitespace only is empty, not a blank name", "   \t ", ""},
		{"inner runs collapse", "Lakshmaji   M", "Lakshmaji M"},
		{"newlines cannot draw a second line on a peer's map", "Rexy\nT-Rex", "Rexy T-Rex"},
		{"control characters are dropped", "Re\x00x\x07y", "Rexy"},
		{"emoji and CJK survive", "🦖 恐竜", "🦖 恐竜"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := NormalizeUsername(tt.in); got != tt.want {
				t.Errorf("NormalizeUsername(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestValidateUsername(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		wantErr bool
	}{
		{"empty is the default", "", false},
		{"ordinary name", "Lakshmaji", false},
		{"at the limit", strings.Repeat("a", MaxUsernameLen), false},
		{"one over", strings.Repeat("a", MaxUsernameLen+1), true},
		{"padding does not count toward the limit", " " + strings.Repeat("a", MaxUsernameLen) + " ", false},
		// Bytes would cut this at a third of the characters the user can see.
		{"multi-byte runes are counted as characters", strings.Repeat("恐", MaxUsernameLen), false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateUsername(tt.in)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateUsername(%q) error = %v, wantErr %v", tt.in, err, tt.wantErr)
			}
		})
	}
}

func TestUsernameSurvivesTheStore(t *testing.T) {
	isolateHome(t)
	s := NewStore()

	if _, err := s.Save(models.Settings{Username: "  Lakshmaji  "}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got := s.Get().Username; got != "Lakshmaji" {
		t.Errorf("Username = %q, want %q", got, "Lakshmaji")
	}

	// Clearing it must mean "back to the hostname", not "a device with no name".
	if _, err := s.Save(models.Settings{Username: ""}); err != nil {
		t.Fatalf("Save empty: %v", err)
	}
	if got := s.Get().Username; got != "" {
		t.Errorf("cleared Username = %q, want empty", got)
	}
}

func TestValidateDroneVariant(t *testing.T) {
	tests := []struct {
		name    string
		id      string
		wantErr bool
	}{
		{"empty means the default", "", false},
		{"plain slug", "scout", false},
		{"dashes and digits", "hex-scout-2", false},
		{"padded is trimmed, not rejected", "  scout  ", false},
		{"uppercase", "Scout", true},
		{"spaces inside", "hex scout", true},
		{"path separator", "../etc/passwd", true},
		{"too long", strings.Repeat("a", MaxVariantIDLen+1), true},
		{"at the length limit", strings.Repeat("a", MaxVariantIDLen), false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateDroneVariant(tt.id)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateDroneVariant(%q) error = %v, wantErr %v", tt.id, err, tt.wantErr)
			}
		})
	}
}

func TestNormalizeTrimsDroneFields(t *testing.T) {
	got := Normalize(models.Settings{
		DroneVariant:   "  hexscout ",
		DroneFanClip:   " /fan.mp3 ",
		DroneCrashClip: " /boom.wav ",
	})
	if got.DroneVariant != "hexscout" {
		t.Errorf("DroneVariant = %q, want %q", got.DroneVariant, "hexscout")
	}
	if got.DroneFanClip != "/fan.mp3" {
		t.Errorf("DroneFanClip = %q, want %q", got.DroneFanClip, "/fan.mp3")
	}
	if got.DroneCrashClip != "/boom.wav" {
		t.Errorf("DroneCrashClip = %q, want %q", got.DroneCrashClip, "/boom.wav")
	}
}
