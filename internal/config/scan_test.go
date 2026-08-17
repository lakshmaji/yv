package config

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"yv/internal/models"
)

func TestSkipDir(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		// dependency trees and build output
		{"node_modules", true},
		{"dist", true},
		{"build", true},
		{"out", true},
		{"target", true},
		{"vendor", true},
		{"__pycache__", true},
		{"captures", true},
		// iOS
		{"Pods", true},
		{"Carthage", true},
		{"DerivedData", true},
		{"MyApp.xcodeproj", true},
		{"MyApp.xcworkspace", true},
		// covered by the dot rule rather than the list
		{".git", true},
		{".gradle", true},
		{".cxx", true},
		{".build", true},
		{".next", true},
		{".venv", true},
		// real project folders that merely look like the above
		{"src", false},
		{"builder", false},
		{"distribution", false},
		{"outbound", false},
		{"my-app", false},
		{"podspecs", false},
		{"android", false},
		{"ios", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := skipDir(tt.name); got != tt.want {
				t.Errorf("skipDir(%q) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}

func TestIsConfigName(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"yv.yaml", true},
		{"yv.yml", true},
		{"yv.yaml.bak", false},
		{"yv.yaml.example", false},
		{"my-yv.yaml", false},
		{"yv.json", false},
		{"YV.YAML", false}, // exact, so a case-insensitive filesystem cannot surprise us
		{"yv", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isConfigName(tt.name); got != tt.want {
				t.Errorf("isConfigName(%q) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}

// writeTree lays out files relative to a fresh temp dir. Values are file
// contents; directories are created as needed.
func writeTree(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for rel, body := range files {
		full := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func cfg(id string) string {
	return fmt.Sprintf("id: %s\nname: %s\ncommands:\n  - id: %s-c1\n    label: Build\n    command: make\n    group: G\n", id, id, id)
}

func hitPaths(t *testing.T, root string) []string {
	t.Helper()
	isolateHome(t)
	res := NewStore().ScanForConfigs(context.Background(), root)
	if res.Truncated != "" {
		t.Fatalf("unexpected truncation: %s", res.Truncated)
	}
	var out []string
	for _, h := range res.Hits {
		rel, _ := filepath.Rel(root, h.Path)
		out = append(out, rel)
	}
	return out
}

func TestScanFindsConfigsAndPrunesTheRest(t *testing.T) {
	root := writeTree(t, map[string]string{
		"alpha/yv.yaml":             cfg("alpha"),
		"beta/yv.yml":               cfg("beta"),
		"deep/nested/again/yv.yaml": cfg("deep"),

		// every one of these must be pruned or ignored
		"alpha/node_modules/pkg/yv.yaml": cfg("nm"),
		"beta/ios/Pods/Some/yv.yaml":     cfg("pods"),
		"gamma/build/yv.yaml":            cfg("build"),
		"gamma/.git/yv.yaml":             cfg("git"),
		"gamma/.gradle/yv.yaml":          cfg("gradle"),
		"delta/App.xcodeproj/yv.yaml":    cfg("xcode"),
		"delta/target/yv.yaml":           cfg("target"),
		"eps/yv.yaml.bak":                cfg("bak"),
		"eps/my-yv.yaml":                 cfg("prefixed"),
		"eps/readme.md":                  "hello",
	})

	got := hitPaths(t, root)
	want := map[string]bool{
		filepath.Join("alpha", "yv.yaml"):                   true,
		filepath.Join("beta", "yv.yml"):                     true,
		filepath.Join("deep", "nested", "again", "yv.yaml"): true,
	}
	if len(got) != len(want) {
		t.Fatalf("got %d hits %v, want %d", len(got), got, len(want))
	}
	for _, g := range got {
		if !want[g] {
			t.Errorf("unexpected hit: %s", g)
		}
	}
}

func TestScanReportsNewVersusExisting(t *testing.T) {
	isolateHome(t)
	root := writeTree(t, map[string]string{
		"fresh/yv.yaml": cfg("fresh"),
		"known/yv.yaml": cfg("known"),
	})

	s := NewStore()
	// A stored project with three commands, so a row can read "3 -> 1".
	stored := models.Project{ID: "known", Name: "Known"}
	for i := 0; i < 3; i++ {
		stored.Commands = append(stored.Commands, models.CommandConfig{
			ID: fmt.Sprintf("known-c%d", i), Label: "L", Command: "make", Group: "G",
		})
	}
	if got := s.SaveProjects([]models.Project{stored}); got != "ok" {
		t.Fatalf("seed: %s", got)
	}

	res := s.ScanForConfigs(context.Background(), root)
	if res.Truncated != "" {
		t.Fatalf("truncated: %s", res.Truncated)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("got %d hits, want 2", len(res.Hits))
	}

	exists := map[string]bool{}
	for _, h := range res.Hits {
		exists[h.Project.ID] = h.Exists
		if h.Project.ID == "known" && h.ExistingCommands != 3 {
			t.Errorf("ExistingCommands: got %d, want 3", h.ExistingCommands)
		}
		if h.Hash == "" {
			t.Errorf("%s: no hash recorded", h.Project.ID)
		}
	}
	if exists["fresh"] {
		t.Error("a project id not in the config was reported as existing")
	}
	if !exists["known"] {
		t.Error("a project id already in the config was not reported as existing")
	}
}

func TestScanBounds(t *testing.T) {
	t.Run("depth", func(t *testing.T) {
		deep := strings.Repeat("a/", maxScanDepth+3)
		root := writeTree(t, map[string]string{
			"shallow/yv.yaml": cfg("shallow"),
			deep + "yv.yaml":  cfg("toodeep"),
		})
		got := hitPaths(t, root)
		if len(got) != 1 {
			t.Fatalf("got %v, want only the shallow one", got)
		}
	})

	t.Run("oversized file is reported not read", func(t *testing.T) {
		isolateHome(t)
		root := writeTree(t, map[string]string{
			"big/yv.yaml": strings.Repeat("x", maxYAMLSize+1),
		})
		res := NewStore().ScanForConfigs(context.Background(), root)
		if len(res.Hits) != 1 {
			t.Fatalf("got %d hits, want 1", len(res.Hits))
		}
		if !strings.Contains(res.Hits[0].Error, "larger than") {
			t.Errorf("Error: got %q, want a size complaint", res.Hits[0].Error)
		}
		// It carries a stand-in hash keyed on the size rather than the contents,
		// so the user can dismiss it — but the read it exists to avoid must not
		// have happened, which is what the size-derived form proves.
		if !strings.HasPrefix(res.Hits[0].Hash, "oversize-") {
			t.Errorf("Hash: got %q, want a size-derived stand-in (the file must not be read)", res.Hits[0].Hash)
		}
	})

	t.Run("cancelled context stops the walk", func(t *testing.T) {
		isolateHome(t)
		root := writeTree(t, map[string]string{"a/yv.yaml": cfg("a")})
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		res := NewStore().ScanForConfigs(ctx, root)
		if res.Truncated == "" {
			t.Error("a cancelled scan must say it stopped early")
		}
	})

	t.Run("missing root is reported", func(t *testing.T) {
		isolateHome(t)
		res := NewStore().ScanForConfigs(context.Background(), filepath.Join(t.TempDir(), "nope"))
		if res.Truncated == "" {
			t.Error("a missing folder must be reported, not returned as zero hits")
		}
	})

	t.Run("empty root is reported", func(t *testing.T) {
		isolateHome(t)
		res := NewStore().ScanForConfigs(context.Background(), "  ")
		if res.Truncated == "" {
			t.Error("no folder chosen must be reported")
		}
	})
}

// An unreadable directory must cost only itself, never the rest of the scan.
func TestScanSurvivesAnUnreadableDirectory(t *testing.T) {
	root := writeTree(t, map[string]string{
		"ok/yv.yaml":     cfg("ok"),
		"locked/yv.yaml": cfg("locked"),
	})
	locked := filepath.Join(root, "locked")
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Skipf("cannot chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	isolateHome(t)
	res := NewStore().ScanForConfigs(context.Background(), root)
	if res.Truncated != "" {
		t.Fatalf("one locked folder aborted the scan: %s", res.Truncated)
	}
	found := false
	for _, h := range res.Hits {
		if h.Project.ID == "ok" {
			found = true
		}
	}
	if !found {
		t.Error("the readable project was lost because of an unreadable sibling")
	}
}

// The config file arrives by git clone and is written by hand, so every rule
// here is a rejection the user must be told about rather than a silent repair.
func TestValidateScanned(t *testing.T) {
	tests := []struct {
		name        string
		yaml        string
		wantErr     string // substring; empty means the file is accepted
		wantDropped int
	}{
		{
			name:    "no id",
			yaml:    "name: Thing\ncommands:\n  - id: c1\n    command: make\n",
			wantErr: "no id",
		},
		{
			name:    "id with a space",
			yaml:    "id: my project\ncommands:\n  - id: c1\n    command: make\n",
			wantErr: "must be 1-64 characters",
		},
		{
			name:    "id with a slash",
			yaml:    "id: a/b\ncommands:\n  - id: c1\n    command: make\n",
			wantErr: "must be 1-64 characters",
		},
		{
			name:    "duplicate command ids",
			yaml:    "id: p\ncommands:\n  - id: c1\n    command: make\n  - id: c1\n    command: test\n",
			wantErr: "duplicate command id",
		},
		{
			name:    "no usable commands",
			yaml:    "id: p\ncommands: []\n",
			wantErr: "no usable commands",
		},
		{
			name:        "commands missing a command string are dropped",
			yaml:        "id: p\ncommands:\n  - id: c1\n    command: make\n  - id: c2\n    command: \"\"\n",
			wantDropped: 1,
		},
		{
			name: "valid",
			yaml: "id: p\nname: P\ncommands:\n  - id: c1\n    command: make\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := unmarshalOneProject([]byte(tt.yaml))
			if err != nil && tt.wantErr == "" {
				t.Fatalf("parse: %v", err)
			}
			dropped, err := validateScanned(&p, "/tmp/thing")

			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("expected an error containing %q, got none", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Errorf("error: got %q, want it to contain %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if dropped != tt.wantDropped {
				t.Errorf("dropped: got %d, want %d", dropped, tt.wantDropped)
			}
		})
	}
}

// A committed config should not have to carry the absolute path of whichever
// machine it was authored on, so an omitted workingDir means "where I live".
func TestValidateScannedFillsDefaultsFromTheFolder(t *testing.T) {
	p, err := unmarshalOneProject([]byte("id: p\ncommands:\n  - id: c1\n    command: make\n"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := validateScanned(&p, "/home/dev/development/storefront"); err != nil {
		t.Fatal(err)
	}
	if p.WorkingDir != "/home/dev/development/storefront" {
		t.Errorf("WorkingDir: got %q, want the containing folder", p.WorkingDir)
	}
	if p.Name != "storefront" {
		t.Errorf("Name: got %q, want the folder name", p.Name)
	}
}

func TestValidateScannedKeepsAnExplicitWorkingDir(t *testing.T) {
	p, err := unmarshalOneProject([]byte("id: p\nworkingDir: /opt/elsewhere\ncommands:\n  - id: c1\n    command: make\n"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := validateScanned(&p, "/home/dev/thing"); err != nil {
		t.Fatal(err)
	}
	if p.WorkingDir != "/opt/elsewhere" {
		t.Errorf("WorkingDir: got %q, want the value from the file", p.WorkingDir)
	}
}

func TestValidateScannedBounds(t *testing.T) {
	build := func(n int) models.Project {
		p := models.Project{ID: "p"}
		for i := 0; i < n; i++ {
			p.Commands = append(p.Commands, models.CommandConfig{
				ID: fmt.Sprintf("c%d", i), Command: "make",
			})
		}
		return p
	}

	t.Run("too many commands", func(t *testing.T) {
		p := build(maxCommandsPerProject + 1)
		if _, err := validateScanned(&p, "/tmp"); err == nil {
			t.Error("expected a rejection")
		}
	})
	t.Run("at the limit is fine", func(t *testing.T) {
		p := build(maxCommandsPerProject)
		if _, err := validateScanned(&p, "/tmp"); err != nil {
			t.Errorf("unexpected error: %v", err)
		}
	})
	t.Run("command string too long", func(t *testing.T) {
		p := models.Project{ID: "p", Commands: []models.CommandConfig{
			{ID: "c1", Command: strings.Repeat("x", maxCommandLen+1)},
		}}
		if _, err := validateScanned(&p, "/tmp"); err == nil {
			t.Error("expected a rejection")
		}
	})
	t.Run("label too long", func(t *testing.T) {
		p := models.Project{ID: "p", Commands: []models.CommandConfig{
			{ID: "c1", Command: "make", Label: strings.Repeat("x", maxLabelLen+1)},
		}}
		if _, err := validateScanned(&p, "/tmp"); err == nil {
			t.Error("expected a rejection")
		}
	})
	t.Run("too many groups", func(t *testing.T) {
		p := build(1)
		for i := 0; i <= maxGroupsPerProject; i++ {
			p.Groups = append(p.Groups, fmt.Sprintf("g%d", i))
		}
		if _, err := validateScanned(&p, "/tmp"); err == nil {
			t.Error("expected a rejection")
		}
	})
}

// A broken file must appear in the results carrying its reason. Dropping it
// silently is the one outcome that leaves its author no way to find the typo.
func TestScanListsUnparseableFilesWithTheirReason(t *testing.T) {
	isolateHome(t)
	root := writeTree(t, map[string]string{
		"good/yv.yaml":   cfg("good"),
		"broken/yv.yaml": "id: p\n\tcommands: [oops\n",
		"noid/yv.yaml":   "name: Nameless\ncommands:\n  - id: c1\n    command: make\n",
	})

	res := NewStore().ScanForConfigs(context.Background(), root)
	if len(res.Hits) != 3 {
		t.Fatalf("got %d hits, want 3 — a bad file must still be listed", len(res.Hits))
	}
	errs := 0
	for _, h := range res.Hits {
		if h.Error != "" {
			errs++
		}
	}
	if errs != 2 {
		t.Errorf("got %d error rows, want 2", errs)
	}
}
