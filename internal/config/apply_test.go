package config

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"yv/internal/models"
)

func projectByID(t *testing.T, s *Store, id string) models.Project {
	t.Helper()
	for _, p := range s.LoadProjects() {
		if p.ID == id {
			return p
		}
	}
	t.Fatalf("project %q not found", id)
	return models.Project{}
}

// Replace, not merge. A command the author deleted must be gone: keeping it
// would mean pulling a teammate's change could never remove anything.
func TestApplyScannedReplacesWholesale(t *testing.T) {
	isolateHome(t)
	s := NewStore()

	if got := s.SaveProjects([]models.Project{{
		ID: "pos", Name: "Old Name", WorkingDir: "/old",
		Commands: []models.CommandConfig{
			{ID: "keep", Label: "Keep", Command: "make", Group: "G"},
			{ID: "gone", Label: "Removed upstream", Command: "old", Group: "G"},
		},
	}}); got != "ok" {
		t.Fatalf("seed: %s", got)
	}

	root := writeTree(t, map[string]string{
		"pos/yv.yaml": "id: pos\nname: New Name\ncommands:\n" +
			"  - id: keep\n    label: Keep\n    command: make\n    group: G\n" +
			"  - id: fresh\n    label: Fresh\n    command: test\n    group: G\n",
	})
	path := filepath.Join(root, "pos", "yv.yaml")

	msg, err := s.ApplyScanned([]string{path})
	if err != nil {
		t.Fatalf("ApplyScanned: %v", err)
	}
	if !strings.Contains(msg, "replaced 1") {
		t.Errorf("summary: got %q, want it to mention replacing one", msg)
	}

	got := projectByID(t, s, "pos")
	if got.Name != "New Name" {
		t.Errorf("Name: got %q, want the file's", got.Name)
	}
	if len(got.Commands) != 2 {
		t.Fatalf("got %d commands, want 2", len(got.Commands))
	}
	for _, c := range got.Commands {
		if c.ID == "gone" {
			t.Error("a command removed from the file survived the import — this is a merge, not a replace")
		}
	}
	// The file carried no workingDir, so it takes the folder it was found in.
	if got.WorkingDir != filepath.Join(root, "pos") {
		t.Errorf("WorkingDir: got %q, want the containing folder", got.WorkingDir)
	}
}

func TestApplyScannedAddsUnknownProjects(t *testing.T) {
	isolateHome(t)
	s := NewStore()
	if got := s.SaveProjects([]models.Project{{ID: "existing", Name: "Existing"}}); got != "ok" {
		t.Fatalf("seed: %s", got)
	}

	root := writeTree(t, map[string]string{"newbie/yv.yaml": cfg("newbie")})
	msg, err := s.ApplyScanned([]string{filepath.Join(root, "newbie", "yv.yaml")})
	if err != nil {
		t.Fatalf("ApplyScanned: %v", err)
	}
	if !strings.Contains(msg, "added 1") {
		t.Errorf("summary: got %q", msg)
	}
	if len(s.LoadProjects()) != 2 {
		t.Errorf("got %d projects, want 2 — the existing one must survive", len(s.LoadProjects()))
	}
}

// One unusable file must not cost the user the others in the same batch.
func TestApplyScannedReportsFailuresWithoutLosingTheRest(t *testing.T) {
	isolateHome(t)
	s := NewStore()
	root := writeTree(t, map[string]string{
		"good/yv.yaml": cfg("good"),
		"bad/yv.yaml":  "name: no id here\ncommands:\n  - id: c1\n    command: make\n",
	})

	msg, err := s.ApplyScanned([]string{
		filepath.Join(root, "good", "yv.yaml"),
		filepath.Join(root, "bad", "yv.yaml"),
	})
	if err != nil {
		t.Fatalf("ApplyScanned: %v", err)
	}
	if !strings.Contains(msg, "added 1") || !strings.Contains(msg, "1 failed") {
		t.Errorf("summary: got %q, want both the success and the failure named", msg)
	}
	projectByID(t, s, "good")
}

func TestApplyScannedWithNothingSelected(t *testing.T) {
	isolateHome(t)
	s := NewStore()
	before := len(s.LoadProjects())
	if _, err := s.ApplyScanned(nil); err != nil {
		t.Fatalf("ApplyScanned: %v", err)
	}
	if len(s.LoadProjects()) != before {
		t.Error("an empty selection changed the config")
	}
}

// The peer-share path shares the merge in ImportProjectsFromSlice, whose rule
// is skip-never-overwrite. A device on the network must not be able to replace
// a project, so the scan's replace behaviour must stay out of it.
func TestPeerImportStillSkipsRatherThanReplaces(t *testing.T) {
	isolateHome(t)
	s := NewStore()
	if got := s.SaveProjects([]models.Project{{ID: "mine", Name: "Mine"}}); got != "ok" {
		t.Fatalf("seed: %s", got)
	}

	if _, err := s.ImportProjectsFromSlice([]models.Project{{ID: "mine", Name: "Theirs"}}); err != nil {
		t.Fatalf("ImportProjectsFromSlice: %v", err)
	}
	if got := projectByID(t, s, "mine"); got.Name != "Mine" {
		t.Errorf("Name: got %q — an inbound share overwrote a local project", got.Name)
	}
}

// End to end: what the scanner reports is what applying it produces.
func TestScanThenApply(t *testing.T) {
	isolateHome(t)
	s := NewStore()
	root := writeTree(t, map[string]string{
		"alpha/yv.yaml":                cfg("alpha"),
		"beta/yv.yml":                  cfg("beta"),
		"alpha/node_modules/x/yv.yaml": cfg("decoy"),
	})

	res := s.ScanForConfigs(context.Background(), root)
	if len(res.Hits) != 2 {
		t.Fatalf("got %d hits, want 2", len(res.Hits))
	}

	var paths []string
	for _, h := range res.Hits {
		paths = append(paths, h.Path)
	}
	if _, err := s.ApplyScanned(paths); err != nil {
		t.Fatalf("ApplyScanned: %v", err)
	}

	projectByID(t, s, "alpha")
	projectByID(t, s, "beta")

	// Re-scanning now reports both as replacements rather than additions.
	again := s.ScanForConfigs(context.Background(), root)
	for _, h := range again.Hits {
		if !h.Exists {
			t.Errorf("%s: reported as new after being imported", h.Project.ID)
		}
	}
}
