package env

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"yv/internal/models"
)

func TestMerge(t *testing.T) {
	cases := []struct {
		name string
		base []string
		vars []models.EnvVar
		want []string
	}{
		{
			name: "no vars returns base unchanged",
			base: []string{"PATH=/bin", "HOME=/u"},
			vars: nil,
			want: []string{"PATH=/bin", "HOME=/u"},
		},
		{
			name: "appends new key",
			base: []string{"PATH=/bin"},
			vars: []models.EnvVar{{Key: "API_URL", Value: "https://x"}},
			want: []string{"PATH=/bin", "API_URL=https://x"},
		},
		{
			name: "overrides existing key in place",
			base: []string{"PATH=/bin", "TOKEN=old", "HOME=/u"},
			vars: []models.EnvVar{{Key: "TOKEN", Value: "new"}},
			want: []string{"PATH=/bin", "TOKEN=new", "HOME=/u"},
		},
		{
			name: "later duplicate wins",
			base: []string{"A=1"},
			vars: []models.EnvVar{{Key: "B", Value: "first"}, {Key: "B", Value: "second"}},
			want: []string{"A=1", "B=second"},
		},
		{
			name: "blank key is skipped",
			base: []string{"A=1"},
			vars: []models.EnvVar{{Key: "   ", Value: "x"}, {Key: "B", Value: "2"}},
			want: []string{"A=1", "B=2"},
		},
		{
			name: "key is trimmed",
			base: []string{"A=1"},
			vars: []models.EnvVar{{Key: " B ", Value: "2"}},
			want: []string{"A=1", "B=2"},
		},
		{
			name: "empty value is allowed",
			base: []string{"A=1"},
			vars: []models.EnvVar{{Key: "B", Value: ""}},
			want: []string{"A=1", "B="},
		},
		{
			name: "value containing = is preserved",
			base: []string{},
			vars: []models.EnvVar{{Key: "OPTS", Value: "a=b,c=d"}},
			want: []string{"OPTS=a=b,c=d"},
		},
		{
			name: "PATH can be overridden",
			base: []string{"PATH=/bin"},
			vars: []models.EnvVar{{Key: "PATH", Value: "/custom"}},
			want: []string{"PATH=/custom"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Merge(tc.base, tc.vars)
			if len(got) != len(tc.want) {
				t.Fatalf("length: got %v, want %v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("[%d]: got %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestMergeDoesNotMutateBase(t *testing.T) {
	base := []string{"TOKEN=old"}
	Merge(base, []models.EnvVar{{Key: "TOKEN", Value: "new"}})
	if base[0] != "TOKEN=old" {
		t.Errorf("base mutated: %q", base[0])
	}
}

func TestValidateKey(t *testing.T) {
	cases := []struct {
		name    string
		key     string
		wantErr bool
	}{
		{name: "simple upper", key: "TOKEN"},
		{name: "with underscore", key: "API_URL"},
		{name: "leading underscore", key: "_X"},
		{name: "with digits", key: "PORT2"},
		{name: "lowercase", key: "token"},
		{name: "empty", key: "", wantErr: true},
		{name: "leading digit", key: "2PORT", wantErr: true},
		{name: "with dash", key: "API-URL", wantErr: true},
		{name: "with space", key: "API URL", wantErr: true},
		{name: "with equals", key: "A=B", wantErr: true},
		{name: "with dollar", key: "$HOME", wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateKey(tc.key)
			if tc.wantErr && err == nil {
				t.Errorf("expected error for %q", tc.key)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("unexpected error for %q: %v", tc.key, err)
			}
		})
	}
}

func TestValidate(t *testing.T) {
	cases := []struct {
		name    string
		in      models.ProjectEnvs
		wantErr bool
	}{
		{
			name: "valid",
			in: models.ProjectEnvs{Environments: []models.Environment{
				{ID: "e1", Name: "dev", Vars: []models.EnvVar{{Key: "TOKEN", Value: "x"}}},
			}},
		},
		{
			name: "blank var row ignored",
			in: models.ProjectEnvs{Environments: []models.Environment{
				{ID: "e1", Name: "dev", Vars: []models.EnvVar{{Key: "", Value: "x"}}},
			}},
		},
		{
			name: "empty environment name",
			in: models.ProjectEnvs{Environments: []models.Environment{
				{ID: "e1", Name: "  "},
			}},
			wantErr: true,
		},
		{
			name: "bad variable name",
			in: models.ProjectEnvs{Environments: []models.Environment{
				{ID: "e1", Name: "dev", Vars: []models.EnvVar{{Key: "BAD-KEY", Value: "x"}}},
			}},
			wantErr: true,
		},
		{
			name: "no environments",
			in:   models.ProjectEnvs{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := Validate(tc.in)
			if tc.wantErr != (err != nil) {
				t.Errorf("wantErr=%v, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestActiveVars(t *testing.T) {
	envs := []models.Environment{
		{ID: "dev", Name: "Dev", Vars: []models.EnvVar{{Key: "A", Value: "1"}}},
		{ID: "prod", Name: "Prod", Vars: []models.EnvVar{
			{Key: "A", Value: "2"},
			{Key: "", Value: "dropped"},
		}},
	}

	cases := []struct {
		name     string
		in       models.ProjectEnvs
		wantKeys []string
	}{
		{
			name:     "active dev",
			in:       models.ProjectEnvs{Environments: envs, ActiveID: "dev"},
			wantKeys: []string{"A"},
		},
		{
			name:     "active prod drops blank key",
			in:       models.ProjectEnvs{Environments: envs, ActiveID: "prod"},
			wantKeys: []string{"A"},
		},
		{
			name:     "no active id",
			in:       models.ProjectEnvs{Environments: envs},
			wantKeys: nil,
		},
		{
			name:     "active id not found",
			in:       models.ProjectEnvs{Environments: envs, ActiveID: "ghost"},
			wantKeys: nil,
		},
		{
			name:     "empty store",
			in:       models.ProjectEnvs{ActiveID: "dev"},
			wantKeys: nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ActiveVars(tc.in)
			if len(got) != len(tc.wantKeys) {
				t.Fatalf("got %v, want keys %v", got, tc.wantKeys)
			}
			for i, key := range tc.wantKeys {
				if got[i].Key != key {
					t.Errorf("[%d]: got %q, want %q", i, got[i].Key, key)
				}
			}
		})
	}
}

func TestStoreRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewStore()

	cases := []struct {
		name         string
		projectID    string
		in           models.ProjectEnvs
		wantErr      bool
		wantEnvCount int
		wantActive   string
		wantVarKeys  []string
	}{
		{
			name:      "save and read back",
			projectID: "p1",
			in: models.ProjectEnvs{
				Environments: []models.Environment{
					{ID: "e1", Name: "dev", Vars: []models.EnvVar{{Key: "TOKEN", Value: "s3cret", Secret: true}}},
				},
				ActiveID: "e1",
			},
			wantEnvCount: 1,
			wantActive:   "e1",
			wantVarKeys:  []string{"TOKEN"},
		},
		{
			name:      "blank var rows are dropped",
			projectID: "p2",
			in: models.ProjectEnvs{
				Environments: []models.Environment{
					{ID: "e1", Name: "dev", Vars: []models.EnvVar{{Key: " ", Value: "x"}, {Key: "OK", Value: "1"}}},
				},
				ActiveID: "e1",
			},
			wantEnvCount: 1,
			wantActive:   "e1",
			wantVarKeys:  []string{"OK"},
		},
		{
			name:      "dangling active id resets to none",
			projectID: "p3",
			in: models.ProjectEnvs{
				Environments: []models.Environment{{ID: "e1", Name: "dev"}},
				ActiveID:     "gone",
			},
			wantEnvCount: 1,
			wantActive:   "",
		},
		{
			name:      "invalid key rejected",
			projectID: "p4",
			in: models.ProjectEnvs{
				Environments: []models.Environment{
					{ID: "e1", Name: "dev", Vars: []models.EnvVar{{Key: "BAD KEY", Value: "x"}}},
				},
			},
			wantErr: true,
		},
		{
			name:      "empty project id rejected",
			projectID: "",
			in:        models.ProjectEnvs{},
			wantErr:   true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := s.Save(tc.projectID, tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("Save: %v", err)
			}

			got := s.Get(tc.projectID)
			if len(got.Environments) != tc.wantEnvCount {
				t.Fatalf("environments: got %d, want %d", len(got.Environments), tc.wantEnvCount)
			}
			if got.ActiveID != tc.wantActive {
				t.Errorf("ActiveID: got %q, want %q", got.ActiveID, tc.wantActive)
			}
			if tc.wantVarKeys != nil {
				vars := got.Environments[0].Vars
				if len(vars) != len(tc.wantVarKeys) {
					t.Fatalf("vars: got %v, want keys %v", vars, tc.wantVarKeys)
				}
				for i, key := range tc.wantVarKeys {
					if vars[i].Key != key {
						t.Errorf("var[%d]: got %q, want %q", i, vars[i].Key, key)
					}
				}
			}
		})
	}
}

func TestStoreGetUnknownProject(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	got := NewStore().Get("nope")
	if got.Environments == nil {
		t.Error("Environments should be an empty slice, not nil")
	}
	if len(got.Environments) != 0 || got.ActiveID != "" {
		t.Errorf("expected empty result, got %+v", got)
	}
}

func TestStoreDelete(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewStore()

	if err := s.Save("p1", models.ProjectEnvs{
		Environments: []models.Environment{{ID: "e1", Name: "dev"}},
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := s.Delete("p1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if len(s.Get("p1").Environments) != 0 {
		t.Error("environments survived Delete")
	}
	if err := s.Delete("missing"); err != nil {
		t.Errorf("Delete of unknown project should be a no-op, got %v", err)
	}
}

func TestStoreFileIsOwnerOnly(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	s := NewStore()

	if err := s.Save("p1", models.ProjectEnvs{
		Environments: []models.Environment{
			{ID: "e1", Name: "dev", Vars: []models.EnvVar{{Key: "TOKEN", Value: "s3cret"}}},
		},
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	path, err := storePath()
	if err != nil {
		t.Fatalf("storePath: %v", err)
	}
	if !strings.HasPrefix(path, home) {
		t.Fatalf("store path %q escaped test HOME %q", path, home)
	}
	if filepath.Base(path) != fileName {
		t.Errorf("file name: got %q, want %q", filepath.Base(path), fileName)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("permissions: got %o, want 600", perm)
	}
}

func TestStoreActiveVars(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s := NewStore()
	if err := s.Save("p1", models.ProjectEnvs{
		Environments: []models.Environment{
			{ID: "e1", Name: "dev", Vars: []models.EnvVar{{Key: "A", Value: "1"}}},
			{ID: "e2", Name: "prod", Vars: []models.EnvVar{{Key: "A", Value: "2"}}},
		},
		ActiveID: "e2",
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	vars := s.ActiveVars("p1")
	if len(vars) != 1 || vars[0].Value != "2" {
		t.Errorf("got %+v, want A=2", vars)
	}
}
