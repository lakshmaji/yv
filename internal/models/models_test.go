package models_test

import (
	"encoding/json"
	"testing"

	"nicosia/internal/models"
)

func TestProjectJSONRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		in   models.Project
	}{
		{
			name: "full project",
			in: models.Project{
				ID:         "p1",
				Name:       "Test",
				WorkingDir: "/tmp",
				Groups:     []string{"A", "B"},
				GroupPaths: map[string]string{"A": "/tmp/a"},
				Commands: []models.CommandConfig{
					{
						ID:          "c1",
						Label:       "Build",
						Command:     "make",
						Group:       "A",
						WorkingDir:  "/tmp/a",
						Interactive: true,
						PreCommands: []string{"echo pre"},
						PostCommands: []models.PostCommand{
							{Command: "echo post", Timeout: 30},
						},
					},
				},
				Shortcuts: []models.Shortcut{
					{ID: "s1", Name: "All", CommandIDs: []string{"c1"}},
				},
			},
		},
		{
			name: "empty project",
			in:   models.Project{ID: "p2", Name: "Empty"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data, err := json.Marshal(tc.in)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			var got models.Project
			if err := json.Unmarshal(data, &got); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if got.ID != tc.in.ID || got.Name != tc.in.Name {
				t.Errorf("got {%s %s}, want {%s %s}", got.ID, got.Name, tc.in.ID, tc.in.Name)
			}
			if len(got.Commands) != len(tc.in.Commands) {
				t.Errorf("commands: got %d, want %d", len(got.Commands), len(tc.in.Commands))
			}
		})
	}
}

func TestOmitemptyFields(t *testing.T) {
	cases := []struct {
		name        string
		in          models.CommandConfig
		shouldOmit  []string
		shouldExist []string
	}{
		{
			name:        "zero-value interactive and dirs omitted",
			in:          models.CommandConfig{ID: "c1", Label: "L", Command: "cmd", Group: "G"},
			shouldOmit:  []string{"workingDir", "interactive", "preCommands", "postCommands"},
			shouldExist: []string{"id", "label", "command", "group"},
		},
		{
			name:        "interactive true is included",
			in:          models.CommandConfig{ID: "c1", Label: "L", Command: "cmd", Group: "G", Interactive: true},
			shouldExist: []string{"interactive"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data, err := json.Marshal(tc.in)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			s := string(data)
			for _, key := range tc.shouldOmit {
				if contains(s, `"`+key+`"`) {
					t.Errorf("expected %q to be omitted, but found in: %s", key, s)
				}
			}
			for _, key := range tc.shouldExist {
				if !contains(s, `"`+key+`"`) {
					t.Errorf("expected %q to be present, but not found in: %s", key, s)
				}
			}
		})
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsStr(s, sub))
}

func containsStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
