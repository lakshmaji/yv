package config

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// devTree builds the shape this feature is actually for: one folder holding
// many repositories, each with its own committed config, plus the decoys a real
// checkout is full of.
func devTree(t *testing.T, n int) string {
	t.Helper()
	files := map[string]string{}
	for i := 1; i <= n; i++ {
		id := fmt.Sprintf("proj%02d", i)
		files[id+"/yv.yaml"] = fmt.Sprintf(
			"id: %s\nname: Project %d\ncommands:\n"+
				"  - id: %s-build\n    label: Build\n    command: make build\n    group: Build\n"+
				"  - id: %s-test\n    label: Test\n    command: make test\n    group: Build\n",
			id, i, id, id)
	}
	// None of these may ever be found.
	decoy := files["proj01/yv.yaml"]
	files["proj01/node_modules/pkg/yv.yaml"] = decoy
	files["proj02/ios/Pods/Lib/yv.yaml"] = decoy
	files["proj03/build/yv.yaml"] = decoy
	files["proj04/.git/yv.yaml"] = decoy
	files["proj05/App.xcodeproj/yv.yaml"] = decoy
	files["proj06/yv.yaml.bak"] = decoy
	files["proj07/my-yv.yaml"] = decoy
	// One genuinely broken file, which must be reported rather than hidden.
	files["proj08/yv.yml"] = "id: broken\n\tcommands: [oops\n"
	return writeTree(t, files)
}

// The whole flow at the scale it is meant for: find, import, stay quiet, notice
// an edit, replace rather than merge, and record all of it.
func TestEighteenProjectsEndToEnd(t *testing.T) {
	isolateHome(t)
	s := NewStore()
	root := devTree(t, 18)

	baseline := len(s.LoadProjects()) // a fresh install seeds a sample project

	res := s.ScanForConfigs(context.Background(), root)
	if res.Truncated != "" {
		t.Fatalf("truncated: %s", res.Truncated)
	}

	var usable []string
	broken := 0
	for _, h := range res.Hits {
		if h.Error != "" {
			broken++
			continue
		}
		usable = append(usable, h.Path)
		if h.Exists {
			t.Errorf("%s reported as existing on a fresh install", h.Project.ID)
		}
	}
	if len(usable) != 18 {
		t.Fatalf("usable hits: got %d, want 18 (decoys must be pruned)", len(usable))
	}
	if broken != 1 {
		t.Errorf("broken hits: got %d, want 1", broken)
	}

	if _, err := s.ApplyScanned(usable); err != nil {
		t.Fatalf("ApplyScanned: %v", err)
	}
	if got := len(s.LoadProjects()); got != baseline+18 {
		t.Errorf("got %d projects, want %d", got, baseline+18)
	}
	s.MarkSeen(res.Hits)

	// Answered means answered: a rescan interrupts nobody.
	quiet := s.ScanForConfigs(context.Background(), root)
	if pending := s.UnseenHits(quiet.Hits); len(pending) != 0 {
		t.Errorf("rescan re-offered %d files, want 0: %+v", len(pending), pending)
	}
	for _, h := range quiet.Hits {
		if h.Error == "" && !h.Exists {
			t.Errorf("%s reported as new after import", h.Project.ID)
		}
	}

	// Edit one file, dropping a command. Only that one becomes interesting.
	edited := "id: proj01\nname: Project 1 renamed\ncommands:\n" +
		"  - id: proj01-build\n    label: Build\n    command: make build\n    group: Build\n"
	if err := os.WriteFile(filepath.Join(root, "proj01", "yv.yaml"), []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}

	third := s.ScanForConfigs(context.Background(), root)
	pending := s.UnseenHits(third.Hits)
	if len(pending) != 1 {
		t.Fatalf("got %d files offered again, want 1: %+v", len(pending), pending)
	}
	hit := pending[0]
	if hit.Project.ID != "proj01" || !hit.Exists {
		t.Fatalf("wrong row offered: %+v", hit)
	}
	if hit.ExistingCommands != 2 || len(hit.Project.Commands) != 1 {
		t.Errorf("row should read 2 -> 1 commands, got %d -> %d",
			hit.ExistingCommands, len(hit.Project.Commands))
	}

	if _, err := s.ApplyScanned([]string{hit.Path}); err != nil {
		t.Fatal(err)
	}
	got := projectByID(t, s, "proj01")
	if got.Name != "Project 1 renamed" {
		t.Errorf("Name: got %q", got.Name)
	}
	if len(got.Commands) != 1 {
		t.Errorf("kept %d commands, want 1 — the removed one survived a replace", len(got.Commands))
	}
	if n := len(s.LoadProjects()); n != baseline+18 {
		t.Errorf("replacing changed the project count to %d", n)
	}

	hist := s.GetImportHistory(50)
	if len(hist) != 19 {
		t.Fatalf("history: got %d entries, want 19 (18 added + 1 replaced)", len(hist))
	}
	if hist[0].Action != "replaced" || hist[0].ProjectID != "proj01" {
		t.Errorf("newest history entry: %+v", hist[0])
	}
	if hist[0].Path == "" || hist[0].At == "" {
		t.Errorf("history entry missing path or timestamp: %+v", hist[0])
	}
}

// An oversized config must be dismissible. It is never read, so it has no
// content hash — without a stand-in it would be re-offered on every scan for
// ever, and the user has no way to end that.
func TestOversizedConfigCanBeAnswered(t *testing.T) {
	isolateHome(t)
	s := NewStore()
	root := writeTree(t, map[string]string{
		"big/yv.yaml": string(make([]byte, maxYAMLSize+1)),
	})

	res := s.ScanForConfigs(context.Background(), root)
	if len(res.Hits) != 1 || res.Hits[0].Error == "" {
		t.Fatalf("want one error hit, got %+v", res.Hits)
	}
	s.MarkSeen(res.Hits)

	again := s.ScanForConfigs(context.Background(), root)
	if pending := s.UnseenHits(again.Hits); len(pending) != 0 {
		t.Errorf("an answered oversized file is still being offered: %+v", pending)
	}
}
