package config

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"gopkg.in/yaml.v3"
	"yv/internal/atomicfile"
	"yv/internal/models"
)

// ConfigFileName is the name a project's committed config must have for the
// folder scanner to find it. yv.yml is accepted as an alternative spelling.
const (
	ConfigFileName    = "yv.yaml"
	ConfigFileNameAlt = "yv.yml"
)

// yamlFilter is the save-dialog filter. Export is YAML and nothing else: two
// interchangeable formats means two ways to spell the same file and a format
// argument threaded through the API for no benefit anyone can see.
var yamlFilter = wailsRuntime.FileFilter{
	DisplayName: "YAML (*.yaml;*.yml)",
	Pattern:     "*.yaml;*.yml",
}

// importFilter still admits .json, because JSON is valid YAML and so files
// exported by an older build cost nothing to keep reading.
var importFilter = wailsRuntime.FileFilter{
	DisplayName: "yv config (*.yaml;*.yml;*.json)",
	Pattern:     "*.yaml;*.yml;*.json",
}

// Store is a file-backed persistence layer. All state lives on disk; the mutex
// exists only to serialise the read-modify-write cycles.
//
// Every mutating method here is load -> mutate -> write. Two of those
// interleaving means one silently discards the other's changes, and there are
// now several writers: the frontend saves on every command edit, an inbound
// peer share merges projects, and a folder scan rewrites the file wholesale.
// The lock is never held across a file dialog — a modal open for a minute must
// not block the app.
type Store struct {
	mu sync.Mutex
}

func NewStore() *Store { return &Store{} }

// LoadProjects reads the stored projects.
//
// Deliberately takes no lock: writeProjects renames a fully-written file into
// place, so a reader observes either the previous file or the next one and can
// never see a torn write. Taking the lock here would only make an ordinary read
// wait behind an unrelated save.
func (s *Store) LoadProjects() []models.Project { return loadProjects() }

func loadProjects() []models.Project {
	path, err := configPath()
	if err != nil {
		log.Printf("[LoadProjects] %v", err)
		return defaultProjects()
	}

	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		defaults := defaultProjects()
		_ = writeProjects(path, defaults)
		return defaults
	}
	if err != nil {
		log.Printf("[LoadProjects] read: %v", err)
		return defaultProjects()
	}

	var projects []models.Project
	if err := json.Unmarshal(data, &projects); err != nil {
		log.Printf("[LoadProjects] parse: %v", err)
		return defaultProjects()
	}
	return projects
}

func (s *Store) SaveProjects(projects []models.Project) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	path, err := configPath()
	if err != nil {
		return "error: " + err.Error()
	}
	if err := writeProjects(path, projects); err != nil {
		return "error: " + err.Error()
	}
	return "ok"
}

func (s *Store) UpdateProject(projectID, name, workingDir, labelBgColor, labelTxColor string) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	path, err := configPath()
	if err != nil {
		return "error: " + err.Error()
	}

	projects := loadProjects()
	for i, p := range projects {
		if p.ID == projectID {
			projects[i].Name = name
			projects[i].WorkingDir = workingDir
			projects[i].LabelBgColor = labelBgColor
			projects[i].LabelTxColor = labelTxColor
			if err := writeProjects(path, projects); err != nil {
				return "error: " + err.Error()
			}
			return "ok"
		}
	}
	return "error: project not found"
}

// ExportProject opens a save dialog and writes a single project as YAML.
//
// The default filename is yv.yaml rather than the project's name because the
// point of exporting one project is to drop it into that project's repository,
// where the scanner will find it.
func (s *Store) ExportProject(ctx context.Context, projectID string) (string, error) {
	var p *models.Project
	for _, proj := range s.LoadProjects() {
		if proj.ID == projectID {
			p = &proj
			break
		}
	}
	if p == nil {
		return "", fmt.Errorf("project not found")
	}

	path, err := wailsRuntime.SaveFileDialog(ctx, wailsRuntime.SaveDialogOptions{
		Title:           "Export Project",
		DefaultFilename: ConfigFileName,
		Filters:         []wailsRuntime.FileFilter{yamlFilter},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}

	out, err := toYAML(p)
	if err != nil {
		return "", err
	}
	return path, os.WriteFile(path, out, 0o644)
}

// ExportProjects opens a save dialog and writes all projects to the chosen file (JSON or YAML).
func (s *Store) ExportProjects(ctx context.Context) (string, error) {
	path, err := wailsRuntime.SaveFileDialog(ctx, wailsRuntime.SaveDialogOptions{
		Title:           "Export Projects",
		DefaultFilename: "yv-projects.yaml",
		Filters:         []wailsRuntime.FileFilter{yamlFilter},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}

	out, err := marshalProjects(s.LoadProjects())
	if err != nil {
		return "", err
	}
	return path, os.WriteFile(path, out, 0o644)
}

// ImportProjects opens an open dialog, reads the chosen file, and merges new projects (by ID) into the config.
func (s *Store) ImportProjects(ctx context.Context) (string, error) {
	path, err := wailsRuntime.OpenFileDialog(ctx, wailsRuntime.OpenDialogOptions{
		Title:   "Import Projects",
		Filters: []wailsRuntime.FileFilter{importFilter},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}

	incoming, err := unmarshalProjects(data)
	if err != nil {
		return "", fmt.Errorf("parse: %w", err)
	}

	return s.ImportProjectsFromSlice(incoming)
}

// ImportProjectsFromSlice merges projects into the stored config by ID: a
// project with an unseen ID is appended, one whose ID already exists is skipped
// rather than overwritten. Returns a human-readable summary.
//
// Separate from ImportProjects because the merge is also the landing point for
// projects arriving over the network from another device — one implementation
// for both paths, so a change to the merge rule cannot apply to only one of them.
func (s *Store) ImportProjectsFromSlice(incoming []models.Project) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing := loadProjects()
	seen := make(map[string]bool, len(existing))
	for _, p := range existing {
		seen[p.ID] = true
	}

	added, skipped := 0, 0
	for _, p := range incoming {
		if p.ID == "" || seen[p.ID] {
			skipped++
			continue
		}
		seen[p.ID] = true
		existing = append(existing, p)
		added++
	}

	configP, err := configPath()
	if err != nil {
		return "", err
	}
	if err := writeProjects(configP, existing); err != nil {
		return "", err
	}

	if skipped > 0 {
		return fmt.Sprintf("Imported %d project(s), skipped %d (already exist)", added, skipped), nil
	}
	return fmt.Sprintf("Imported %d project(s)", added), nil
}

// ImportProject opens a file dialog and imports exactly one project from JSON or YAML.
// If the file contains an array, only the first project is imported.
// Existing projects are never modified.
func (s *Store) ImportProject(ctx context.Context) (string, error) {
	path, err := wailsRuntime.OpenFileDialog(ctx, wailsRuntime.OpenDialogOptions{
		Title:   "Import Project",
		Filters: []wailsRuntime.FileFilter{importFilter},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}

	p, err := unmarshalOneProject(data)
	if err != nil {
		return "", fmt.Errorf("parse: %w", err)
	}

	// The lock is taken here, not around the dialog: a file picker sitting open
	// must not block every other write in the app.
	s.mu.Lock()
	defer s.mu.Unlock()

	existing := loadProjects()
	for _, e := range existing {
		if e.ID == p.ID {
			return fmt.Sprintf("Skipped: project %q already exists", p.Name), nil
		}
	}

	existing = append(existing, p)
	configP, err := configPath()
	if err != nil {
		return "", err
	}
	if err := writeProjects(configP, existing); err != nil {
		return "", err
	}
	return fmt.Sprintf("Imported project %q", p.Name), nil
}

func configPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("UserConfigDir: %w", err)
	}
	appDir := filepath.Join(dir, "yv")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		return "", fmt.Errorf("MkdirAll: %w", err)
	}
	return filepath.Join(appDir, "projects.json"), nil
}

func writeProjects(path string, projects []models.Project) error {
	data, err := json.MarshalIndent(projects, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.Write(path, data, 0o644)
}

// toYAML encodes v as YAML with the keys the json struct tags name.
//
// yaml.v3 ignores json tags and lowercases the Go field name instead, so
// marshalling a Project directly emits "workingdir" and "precommands". That was
// tolerable while YAML was one of two backup formats; it is not, now that
// yv.yaml is a file people write by hand and commit. Routing through JSON keeps
// one set of field names for the whole app rather than a second set of yaml
// tags to forget to add.
func toYAML(v any) ([]byte, error) {
	j, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	// JSON is valid YAML, and yaml.v3 decodes mappings as map[string]any, so
	// this survives the round trip unchanged.
	var tree any
	if err := yaml.Unmarshal(j, &tree); err != nil {
		return nil, err
	}
	return yaml.Marshal(tree)
}

// fromYAML decodes YAML into out through the same JSON round trip.
//
// This is also what keeps files written by older builds readable: their keys
// are lowercased ("workingdir"), and encoding/json matches object keys to
// struct fields ignoring case, preferring an exact match. Decoding into the
// struct with yaml.v3 directly would match exactly and silently drop them.
func fromYAML(data []byte, out any) error {
	var tree any
	if err := yaml.Unmarshal(data, &tree); err != nil {
		return err
	}
	j, err := json.Marshal(tree)
	if err != nil {
		return err
	}
	return json.Unmarshal(j, out)
}

func marshalProjects(projects []models.Project) ([]byte, error) {
	return toYAML(projects)
}

func unmarshalProjects(data []byte) ([]models.Project, error) {
	var projects []models.Project
	err := fromYAML(data, &projects)
	return projects, err
}

// unmarshalOneProject parses a single Project, accepting either a lone object
// or a list (taking the first entry).
func unmarshalOneProject(data []byte) (models.Project, error) {
	var p models.Project
	if err := fromYAML(data, &p); err == nil && p.ID != "" {
		return p, nil
	}
	var ps []models.Project
	if err := fromYAML(data, &ps); err == nil && len(ps) > 0 {
		return ps[0], nil
	}
	return models.Project{}, fmt.Errorf("no project found in file")
}

func defaultProjects() []models.Project {
	return []models.Project{
		{
			ID:         "pos",
			Name:       "POS",
			WorkingDir: "/Users/lakshmaji/conductor/workspaces/pos-redeem-gf-v1/hot-updater-integration/pos-app/android",
			Groups:     []string{"Android"},
			Commands: []models.CommandConfig{
				{
					ID:      "pos-1",
					Label:   "Clean & Build Release APK",
					Command: "./gradlew clean && ./gradlew app:assembleRelease",
					Group:   "Android",
				},
				{
					ID:      "pos-2",
					Label:   "Install APK",
					Command: "adb install -r app/build/outputs/apk/release/app-release.apk",
					Group:   "Android",
				},
				{
					ID:      "pos-3",
					Label:   "Launch App",
					Command: "adb shell am start -n au.oolio.pos/.MainActivity",
					Group:   "Android",
				},
				{
					ID:      "pos-4",
					Label:   "Force Stop App",
					Command: "adb shell am force-stop au.oolio.pos",
					Group:   "Android",
				},
				{
					ID:      "pos-5",
					Label:   "Start Pixel Tablet Emulator",
					Command: "emulator -avd Pixel_Tablet -no-snapshot-load",
					Group:   "Android",
				},
				{
					ID:      "pos-6",
					Label:   "List AVDs",
					Command: "emulator -list-avds",
					Group:   "Android",
				},
			},
		},
	}
}
