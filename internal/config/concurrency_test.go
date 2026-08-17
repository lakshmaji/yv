package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"yv/internal/models"
)

// isolateHome points os.UserConfigDir at a scratch directory.
//
// Overriding HOME alone is not enough: on Linux os.UserConfigDir prefers
// XDG_CONFIG_HOME and only falls back to $HOME/.config, and CI runners set it —
// so a HOME-only override silently reads and writes the real ~/.config/yv.
func isolateHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	return home
}

func proj(id string, cmds int) models.Project {
	p := models.Project{ID: id, Name: id, WorkingDir: "/tmp/" + id}
	for i := 0; i < cmds; i++ {
		p.Commands = append(p.Commands, models.CommandConfig{
			ID: id + "-cmd", Label: "L", Command: "echo hi", Group: "G",
		})
	}
	return p
}

// Concurrent writers must not interleave a load with another writer's write.
// Run under -race, this is what proves the Store's mutex is actually taken on
// every read-modify-write path; without it the detector fires and, worse, the
// file ends up holding a blend of two writers' states.
func TestConcurrentWritesKeepTheFileValid(t *testing.T) {
	isolateHome(t)
	s := NewStore()

	// Seed, so LoadProjects does not race to write the defaults.
	if got := s.SaveProjects([]models.Project{proj("seed", 1)}); got != "ok" {
		t.Fatalf("seed: %s", got)
	}

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				switch n % 4 {
				case 0:
					s.SaveProjects([]models.Project{proj("a", 3)})
				case 1:
					s.UpdateProject("a", "renamed", "/tmp/x", "", "")
				case 2:
					s.ImportProjectsFromSlice([]models.Project{proj("b", 2)})
				case 3:
					_ = s.LoadProjects()
				}
			}
		}(i)
	}
	wg.Wait()

	// Whatever won, the file must be complete and parseable — never truncated
	// and never two writers' bytes spliced together.
	path, err := configPath()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var out []models.Project
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("config is corrupt after concurrent writes: %v\n%s", err, raw)
	}
	if len(out) == 0 {
		t.Error("config ended up empty")
	}
}

// The temp files atomicfile creates must never accumulate in the config dir.
func TestWritingLeavesNoTempFilesInConfigDir(t *testing.T) {
	isolateHome(t)
	s := NewStore()
	for i := 0; i < 5; i++ {
		s.SaveProjects([]models.Project{proj("a", 1)})
	}

	path, err := configPath()
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("temp file left in config dir: %s", e.Name())
		}
	}
}

// projects.json must stay group/world readable after the switch to a temp file,
// which os.CreateTemp creates as 0600.
func TestSavedConfigKeepsItsMode(t *testing.T) {
	isolateHome(t)
	s := NewStore()
	if got := s.SaveProjects([]models.Project{proj("a", 1)}); got != "ok" {
		t.Fatalf("save: %s", got)
	}

	path, err := configPath()
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o644 {
		t.Errorf("mode: got %v, want 0644", fi.Mode().Perm())
	}
}
