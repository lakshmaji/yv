package config

import (
	"strings"
	"testing"

	"yv/internal/models"
)

func TestMarshalUnmarshalProjects(t *testing.T) {
	cases := []struct {
		name string
		in   []models.Project
	}{
		{"single project", []models.Project{{ID: "p1", Name: "Test", WorkingDir: "/tmp"}}},
		{"empty slice", []models.Project{}},
		{"multiple projects", []models.Project{{ID: "p1", Name: "First"}, {ID: "p2", Name: "Second"}}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data, err := marshalProjects(tc.in)
			if err != nil {
				t.Fatalf("marshalProjects: %v", err)
			}
			got, err := unmarshalProjects(data)
			if err != nil {
				t.Fatalf("unmarshalProjects: %v", err)
			}
			if len(got) != len(tc.in) {
				t.Fatalf("length: got %d, want %d", len(got), len(tc.in))
			}
			for i := range tc.in {
				if got[i].ID != tc.in[i].ID {
					t.Errorf("[%d] ID: got %q, want %q", i, got[i].ID, tc.in[i].ID)
				}
				if got[i].Name != tc.in[i].Name {
					t.Errorf("[%d] Name: got %q, want %q", i, got[i].Name, tc.in[i].Name)
				}
			}
		})
	}
}

// The emitted keys must be the json tag names. yaml.v3 lowercases Go field
// names when left to itself, which would put "workingdir" and "precommands" in
// a file people are told to hand-edit and commit.
func TestExportedYAMLUsesTheJSONFieldNames(t *testing.T) {
	data, err := toYAML(models.Project{
		ID:         "p1",
		Name:       "Test",
		WorkingDir: "/tmp",
		Commands: []models.CommandConfig{{
			ID: "c1", Label: "Build", Command: "make", Group: "G",
			WorkingDir:   "/tmp/sub",
			PreCommands:  []string{"nvm use 18"},
			PostCommands: []models.PostCommand{{Command: "say done", Timeout: 5}},
		}},
	})
	if err != nil {
		t.Fatalf("toYAML: %v", err)
	}

	for _, want := range []string{"workingDir:", "preCommands:", "postCommands:"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("missing %q in:\n%s", want, data)
		}
	}
	for _, bad := range []string{"workingdir:", "precommands:", "postcommands:"} {
		if strings.Contains(string(data), bad) {
			t.Errorf("emitted lowercased key %q in:\n%s", bad, data)
		}
	}
}

// A file written by a build from before the casing fix has all-lowercase keys.
// Those still load, because encoding/json matches object keys to struct fields
// ignoring case. That is a property of the stdlib rather than of this code, so
// it is pinned here: a refactor away from the JSON round trip would silently
// start dropping every multi-word field of everyone's existing exports.
func TestOldLowercaseKeysStillLoad(t *testing.T) {
	old := `
- id: p1
  name: Legacy
  workingdir: /tmp/legacy
  groups: [Android]
  grouppaths:
    Android: /tmp/legacy/android
  labelbgcolor: "#123456"
  commands:
    - id: c1
      label: Build
      command: make
      group: Android
      workingdir: /tmp/legacy/sub
      precommands: ["nvm use 18"]
      postcommands:
        - command: say done
          timeout: 5
`
	got, err := unmarshalProjects([]byte(old))
	if err != nil {
		t.Fatalf("unmarshalProjects: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d projects, want 1", len(got))
	}
	p := got[0]
	if p.WorkingDir != "/tmp/legacy" {
		t.Errorf("WorkingDir: got %q, want %q", p.WorkingDir, "/tmp/legacy")
	}
	if p.GroupPaths["Android"] != "/tmp/legacy/android" {
		t.Errorf("GroupPaths: got %v", p.GroupPaths)
	}
	if p.LabelBgColor != "#123456" {
		t.Errorf("LabelBgColor: got %q", p.LabelBgColor)
	}
	if len(p.Commands) != 1 {
		t.Fatalf("got %d commands, want 1", len(p.Commands))
	}
	c := p.Commands[0]
	if c.WorkingDir != "/tmp/legacy/sub" {
		t.Errorf("cmd WorkingDir: got %q", c.WorkingDir)
	}
	if len(c.PreCommands) != 1 || c.PreCommands[0] != "nvm use 18" {
		t.Errorf("PreCommands: got %v", c.PreCommands)
	}
	if len(c.PostCommands) != 1 || c.PostCommands[0].Timeout != 5 {
		t.Errorf("PostCommands: got %v", c.PostCommands)
	}
}

func TestUnmarshalOneProject(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantID  string
		wantErr bool
	}{
		{name: "yaml single object", input: "id: p1\nname: Test\n", wantID: "p1"},
		{name: "yaml list takes first", input: "- id: p1\n  name: First\n- id: p2\n", wantID: "p1"},
		// JSON is valid YAML, so an export from an older build still reads.
		{name: "json single object", input: `{"id":"p1","name":"Test"}`, wantID: "p1"},
		{name: "json array takes first", input: `[{"id":"p1"},{"id":"p2"}]`, wantID: "p1"},
		{name: "not parseable", input: "\tid: [unclosed", wantErr: true},
		{name: "empty object has no id", input: `{}`, wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := unmarshalOneProject([]byte(tc.input))
			if tc.wantErr {
				if err == nil {
					t.Errorf("expected error, got project %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.ID != tc.wantID {
				t.Errorf("ID: got %q, want %q", got.ID, tc.wantID)
			}
		})
	}
}

func TestConfigPath(t *testing.T) {
	// configPath has an MkdirAll side effect, so without redirecting the config
	// dir this test creates a real ~/.config/yv. HOME alone is not enough: on
	// Linux os.UserConfigDir prefers XDG_CONFIG_HOME and only falls back to
	// $HOME/.config.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")

	path, err := configPath()
	if err != nil {
		t.Fatalf("configPath: %v", err)
	}
	if !strings.HasSuffix(path, "yv/projects.json") {
		t.Errorf("unexpected path: %q", path)
	}
}

func TestDefaultProjects(t *testing.T) {
	projects := defaultProjects()
	if len(projects) == 0 {
		t.Fatal("defaultProjects returned empty slice")
	}
	pos := projects[0]
	if pos.ID != "pos" {
		t.Errorf("ID: got %q, want %q", pos.ID, "pos")
	}
	if pos.Name != "POS" {
		t.Errorf("Name: got %q, want %q", pos.Name, "POS")
	}
	if len(pos.Commands) == 0 {
		t.Error("POS project has no commands")
	}
	for _, cmd := range pos.Commands {
		if cmd.Group == "" {
			t.Errorf("command %q has empty group", cmd.Label)
		}
	}
}
