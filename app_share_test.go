package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"yv/internal/config"
	"yv/internal/models"
	"yv/internal/share"
)

// newShareTestApp gives an App backed by a throwaway config dir, so these tests
// never read or write the developer's real projects.json.
func newShareTestApp(t *testing.T, projects []models.Project) *App {
	t.Helper()

	// config.Store resolves its path through os.UserConfigDir. Redirecting HOME
	// is not enough on its own: on Linux os.UserConfigDir prefers
	// XDG_CONFIG_HOME and only falls back to $HOME/.config, so with that set
	// these tests overwrote the developer's real projects.json. Clearing it
	// restores the $HOME fallback on every platform.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")

	cfg := config.NewStore()
	if res := cfg.SaveProjects(projects); res != "ok" {
		t.Fatalf("SaveProjects: %s", res)
	}
	return &App{cfg: cfg}
}

func sampleProjects() []models.Project {
	return []models.Project{
		{
			ID:         "p-pos",
			Name:       "POS",
			WorkingDir: "/tmp/pos",
			Commands: []models.CommandConfig{
				{ID: "c-1", Label: "Build", Command: "make build", Group: "Android"},
				{ID: "c-2", Label: "Install", Command: "adb install app.apk", Group: "Android"},
			},
		},
		{
			ID:         "p-web",
			Name:       "Storefront",
			WorkingDir: "/tmp/web",
			Commands: []models.CommandConfig{
				{ID: "c-3", Label: "Dev", Command: "npm run dev", Group: "Web"},
			},
		},
	}
}

func TestBuildShareScopes(t *testing.T) {
	tests := []struct {
		name         string
		scope        string
		projectID    string
		wantProjects int
		wantName     string
		wantErr      bool
	}{
		{"app scope takes everything", "app", "", 2, "", false},
		{"project scope takes one", "project", "p-pos", 1, "POS", false},
		{"project scope picks the right one", "project", "p-web", 1, "Storefront", false},
		{"unknown project is an error", "project", "nope", 0, "", true},
		{"empty project id is an error", "project", "", 0, "", true},
		{"unknown scope is an error", "everything", "", 0, "", true},
		{"empty scope is an error", "", "", 0, "", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a := newShareTestApp(t, sampleProjects())

			payload, offer, err := a.buildShare(tc.scope, tc.projectID)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("buildShare(%q, %q) = nil error, want one", tc.scope, tc.projectID)
				}
				return
			}
			if err != nil {
				t.Fatalf("buildShare(%q, %q): %v", tc.scope, tc.projectID, err)
			}

			if len(payload.Projects) != tc.wantProjects {
				t.Errorf("payload has %d project(s), want %d", len(payload.Projects), tc.wantProjects)
			}
			if payload.Scope != tc.scope {
				t.Errorf("payload scope = %q, want %q", payload.Scope, tc.scope)
			}
			if offer.ProjectName != tc.wantName {
				t.Errorf("offer.ProjectName = %q, want %q", offer.ProjectName, tc.wantName)
			}
			if offer.ProjectCount != tc.wantProjects {
				t.Errorf("offer.ProjectCount = %d, want %d", offer.ProjectCount, tc.wantProjects)
			}
			if offer.TransferID == "" {
				t.Error("offer.TransferID is empty")
			}
			// The PIN is attached by the caller, never by buildShare.
			if offer.PIN != "" {
				t.Errorf("offer.PIN = %q, want empty", offer.PIN)
			}
		})
	}
}

// The commands are the point of the whole feature, so they had better survive the
// trip from disk into the payload intact.
func TestBuildSharePreservesCommands(t *testing.T) {
	a := newShareTestApp(t, sampleProjects())

	payload, _, err := a.buildShare("project", "p-pos")
	if err != nil {
		t.Fatalf("buildShare: %v", err)
	}

	got := payload.Projects[0]
	if got.Name != "POS" || len(got.Commands) != 2 {
		t.Fatalf("project came through wrong: %+v", got)
	}
	if got.Commands[0].Command != "make build" {
		t.Errorf("command text = %q, want %q", got.Commands[0].Command, "make build")
	}
	if got.WorkingDir != "/tmp/pos" {
		t.Errorf("workingDir = %q, want %q", got.WorkingDir, "/tmp/pos")
	}
}

// SharePayload has no field for environments, and this asserts that nobody has
// quietly added one — secrets living in a separate file is the entire reason
// exported and shared config are safe to hand around.
func TestSharePayloadCarriesNoSecrets(t *testing.T) {
	a := newShareTestApp(t, sampleProjects())

	payload, _, err := a.buildShare("app", "")
	if err != nil {
		t.Fatalf("buildShare: %v", err)
	}

	raw, err := marshalForInspection(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, forbidden := range []string{"environment", "envs", "vars", "secret"} {
		if strings.Contains(strings.ToLower(raw), forbidden) {
			t.Errorf("share payload mentions %q; secrets must never travel with shared config:\n%s",
				forbidden, raw)
		}
	}
}

func TestApplySharedPayloadMerges(t *testing.T) {
	a := newShareTestApp(t, sampleProjects())

	incoming := models.SharePayload{
		Scope: "app",
		Projects: []models.Project{
			// Already present by ID — must be skipped, not overwritten.
			{ID: "p-pos", Name: "POS but theirs", Commands: []models.CommandConfig{{ID: "x", Command: "rm -rf /"}}},
			// New — must be added.
			{ID: "p-new", Name: "Analytics", Commands: []models.CommandConfig{{ID: "c-9", Command: "make run"}}},
		},
	}

	summary := a.applySharedPayload(incoming)
	if !strings.Contains(summary, "Imported 1") {
		t.Errorf("summary = %q, want it to report 1 import", summary)
	}
	if !strings.Contains(summary, "skipped 1") {
		t.Errorf("summary = %q, want it to report 1 skip", summary)
	}

	after := a.cfg.LoadProjects()
	if len(after) != 3 {
		t.Fatalf("have %d projects after merge, want 3", len(after))
	}

	// The local project must be untouched — an incoming share is additive, and
	// silently replacing someone's commands with a stranger's would be the worst
	// possible failure mode here.
	for _, p := range after {
		if p.ID == "p-pos" {
			if p.Name != "POS" {
				t.Errorf("local project was overwritten: name = %q, want %q", p.Name, "POS")
			}
			if len(p.Commands) != 2 || p.Commands[0].Command != "make build" {
				t.Errorf("local commands were replaced: %+v", p.Commands)
			}
		}
	}
}

func TestApplySharedPayloadEmptyIsHarmless(t *testing.T) {
	a := newShareTestApp(t, sampleProjects())

	if summary := a.applySharedPayload(models.SharePayload{Scope: "app"}); summary == "" {
		t.Error("applySharedPayload returned no summary for an empty payload")
	}
	if got := len(a.cfg.LoadProjects()); got != 2 {
		t.Errorf("have %d projects after an empty merge, want the original 2", got)
	}
}

// A payload whose projects have no IDs cannot be merged by ID; they must be
// skipped rather than appended as unaddressable duplicates.
func TestApplySharedPayloadSkipsIDLessProjects(t *testing.T) {
	a := newShareTestApp(t, sampleProjects())

	a.applySharedPayload(models.SharePayload{
		Scope:    "app",
		Projects: []models.Project{{Name: "No ID"}, {Name: "Also No ID"}},
	})

	if got := len(a.cfg.LoadProjects()); got != 2 {
		t.Errorf("have %d projects, want the original 2 — id-less projects should be skipped", got)
	}
}

// marshalForInspection renders a payload as JSON so a test can assert on what is
// and is not in it.
func marshalForInspection(v any) (string, error) {
	raw, err := json.Marshal(v)
	return string(raw), err
}

// A files payload writes to disk and must not touch config. The two scopes go to
// completely different places, and the receiver only agreed to one of them.
func TestApplySharedPayloadSavesFiles(t *testing.T) {
	a := newShareTestApp(t, sampleProjects())

	// newShareTestApp already redirected HOME, and ReceiveDir resolves through
	// it — so overriding it again here would move the config store out from
	// under the app mid-test.
	home := mustHome(t)

	summary := a.applySharedPayload(models.SharePayload{
		Scope: "files",
		Files: []models.SharedFile{
			{Name: "notes.txt", Size: 5, Data: []byte("hello")},
			{Name: "second.txt", Size: 3, Data: []byte("bye")},
		},
	})

	if !strings.Contains(summary, "Saved 2 files") {
		t.Errorf("summary = %q, want it to report 2 saved files", summary)
	}

	dir := filepath.Join(home, share.ReceiveDirName)
	got, err := os.ReadFile(filepath.Join(dir, "notes.txt"))
	if err != nil {
		t.Fatalf("reading the saved file: %v", err)
	}
	if string(got) != "hello" {
		t.Errorf("saved contents = %q, want %q", got, "hello")
	}

	if n := len(a.cfg.LoadProjects()); n != 2 {
		t.Errorf("have %d projects, want the original 2 — a files share must not touch config", n)
	}
}

// The scope decides what happens, not which fields are populated. Otherwise a
// payload that the user accepted as config could still drop files on their disk.
func TestApplySharedPayloadIgnoresFilesOnAConfigScope(t *testing.T) {
	a := newShareTestApp(t, sampleProjects())
	home := mustHome(t)

	a.applySharedPayload(models.SharePayload{
		Scope:    "app",
		Projects: []models.Project{{ID: "p-new", Name: "Analytics"}},
		Files:    []models.SharedFile{{Name: "sneaky.sh", Data: []byte("rm -rf /")}},
	})

	if _, err := os.Stat(filepath.Join(home, share.ReceiveDirName)); !os.IsNotExist(err) {
		t.Error("a config-scoped payload wrote files to disk")
	}
}

// Conversely, a files payload must not be able to add projects.
func TestApplySharedPayloadIgnoresProjectsOnAFilesScope(t *testing.T) {
	a := newShareTestApp(t, sampleProjects())

	a.applySharedPayload(models.SharePayload{
		Scope:    "files",
		Projects: []models.Project{{ID: "p-new", Name: "Analytics"}},
		Files:    []models.SharedFile{{Name: "notes.txt", Data: []byte("hi")}},
	})

	if n := len(a.cfg.LoadProjects()); n != 2 {
		t.Errorf("have %d projects, want the original 2 — a files share must not add projects", n)
	}
}

func TestApplySharedPayloadEmptyFileListIsHarmless(t *testing.T) {
	a := newShareTestApp(t, sampleProjects())

	if summary := a.applySharedPayload(models.SharePayload{Scope: "files"}); summary == "" {
		t.Error("no summary for an empty files payload")
	}
}

// mustHome reads the home directory the test harness redirected, which is where
// ReceiveDir will have put anything the app saved.
func mustHome(t *testing.T) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("home directory: %v", err)
	}
	return home
}
