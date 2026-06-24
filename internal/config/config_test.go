package config

import (
	"strings"
	"testing"

	"nicosia/internal/models"
)

func TestMarshalUnmarshalProjects(t *testing.T) {
	cases := []struct {
		name string
		ext  string
		in   []models.Project
	}{
		{
			name: "json single project",
			ext:  ".json",
			in:   []models.Project{{ID: "p1", Name: "Test", WorkingDir: "/tmp"}},
		},
		{
			name: "yaml single project",
			ext:  ".yaml",
			in:   []models.Project{{ID: "p1", Name: "Test", WorkingDir: "/tmp"}},
		},
		{
			name: "json empty slice",
			ext:  ".json",
			in:   []models.Project{},
		},
		{
			name: "yaml empty slice",
			ext:  ".yaml",
			in:   []models.Project{},
		},
		{
			name: "yml extension",
			ext:  ".yml",
			in:   []models.Project{{ID: "p2", Name: "Second"}},
		},
		{
			name: "json multiple projects",
			ext:  ".json",
			in: []models.Project{
				{ID: "p1", Name: "First"},
				{ID: "p2", Name: "Second"},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data, err := marshalProjects(tc.in, tc.ext)
			if err != nil {
				t.Fatalf("marshalProjects: %v", err)
			}
			got, err := unmarshalProjects(data, tc.ext)
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

func TestUnmarshalOneProject(t *testing.T) {
	cases := []struct {
		name    string
		ext     string
		input   string
		wantID  string
		wantErr bool
	}{
		{
			name:   "json single object",
			ext:    ".json",
			input:  `{"id":"p1","name":"Test"}`,
			wantID: "p1",
		},
		{
			name:   "json array takes first",
			ext:    ".json",
			input:  `[{"id":"p1","name":"First"},{"id":"p2","name":"Second"}]`,
			wantID: "p1",
		},
		{
			name:   "yaml single object",
			ext:    ".yaml",
			input:  "id: p1\nname: Test\n",
			wantID: "p1",
		},
		{
			name:   "yaml array takes first",
			ext:    ".yaml",
			input:  "- id: p1\n  name: First\n- id: p2\n  name: Second\n",
			wantID: "p1",
		},
		{
			name:    "json invalid",
			ext:     ".json",
			input:   `not json`,
			wantErr: true,
		},
		{
			name:    "json empty object no id",
			ext:     ".json",
			input:   `{}`,
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := unmarshalOneProject([]byte(tc.input), tc.ext)
			if tc.wantErr {
				if err == nil {
					t.Error("expected error, got nil")
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
	path, err := configPath()
	if err != nil {
		t.Fatalf("configPath: %v", err)
	}
	if !strings.HasSuffix(path, "nicosia/projects.json") {
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
