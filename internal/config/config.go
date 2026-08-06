package config

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"gopkg.in/yaml.v3"
	"yv/internal/models"
)

// Store is a stateless persistence layer. All state lives on disk.
type Store struct{}

func NewStore() *Store { return &Store{} }

func (s *Store) LoadProjects() []models.Project {
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
	projects := s.LoadProjects()
	for i, p := range projects {
		if p.ID == projectID {
			projects[i].Name = name
			projects[i].WorkingDir = workingDir
			projects[i].LabelBgColor = labelBgColor
			projects[i].LabelTxColor = labelTxColor
			return s.SaveProjects(projects)
		}
	}
	return "error: project not found"
}

// ExportProject opens a save dialog and writes a single project to a file.
func (s *Store) ExportProject(ctx context.Context, projectID, format string) (string, error) {
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

	ext := ".json"
	if format == "yaml" {
		ext = ".yaml"
	}

	path, err := wailsRuntime.SaveFileDialog(ctx, wailsRuntime.SaveDialogOptions{
		Title:           "Export Project",
		DefaultFilename: p.Name + ext,
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: strings.ToUpper(format) + " (*" + ext + ")", Pattern: "*" + ext},
		},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}

	var out []byte
	if format == "yaml" {
		out, err = yaml.Marshal(p)
	} else {
		out, err = json.MarshalIndent(p, "", "  ")
	}
	if err != nil {
		return "", err
	}
	return path, os.WriteFile(path, out, 0o644)
}

// ExportProjects opens a save dialog and writes all projects to the chosen file (JSON or YAML).
func (s *Store) ExportProjects(ctx context.Context) (string, error) {
	path, err := wailsRuntime.SaveFileDialog(ctx, wailsRuntime.SaveDialogOptions{
		Title:           "Export Projects",
		DefaultFilename: "yv-projects.json",
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "JSON (*.json)", Pattern: "*.json"},
			{DisplayName: "YAML (*.yaml)", Pattern: "*.yaml"},
		},
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}

	ext := strings.ToLower(filepath.Ext(path))
	out, err := marshalProjects(s.LoadProjects(), ext)
	if err != nil {
		return "", err
	}
	return path, os.WriteFile(path, out, 0o644)
}

// ImportProjects opens an open dialog, reads the chosen file, and merges new projects (by ID) into the config.
func (s *Store) ImportProjects(ctx context.Context) (string, error) {
	path, err := wailsRuntime.OpenFileDialog(ctx, wailsRuntime.OpenDialogOptions{
		Title: "Import Projects",
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "JSON / YAML (*.json;*.yaml;*.yml)", Pattern: "*.json;*.yaml;*.yml"},
		},
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

	ext := strings.ToLower(filepath.Ext(path))
	incoming, err := unmarshalProjects(data, ext)
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
	existing := s.LoadProjects()
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
		Title: "Import Project",
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "JSON / YAML (*.json;*.yaml;*.yml)", Pattern: "*.json;*.yaml;*.yml"},
		},
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

	ext := strings.ToLower(filepath.Ext(path))
	p, err := unmarshalOneProject(data, ext)
	if err != nil {
		return "", fmt.Errorf("parse: %w", err)
	}

	existing := s.LoadProjects()
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
	return os.WriteFile(path, data, 0o644)
}

func marshalProjects(projects []models.Project, ext string) ([]byte, error) {
	if ext == ".yaml" || ext == ".yml" {
		return yaml.Marshal(projects)
	}
	return json.MarshalIndent(projects, "", "  ")
}

func unmarshalProjects(data []byte, ext string) ([]models.Project, error) {
	var projects []models.Project
	if ext == ".yaml" || ext == ".yml" {
		err := yaml.Unmarshal(data, &projects)
		return projects, err
	}
	err := json.Unmarshal(data, &projects)
	return projects, err
}

// unmarshalOneProject parses a single Project from JSON or YAML.
// Accepts either a single object or an array (takes the first element).
func unmarshalOneProject(data []byte, ext string) (models.Project, error) {
	if ext == ".yaml" || ext == ".yml" {
		var p models.Project
		if err := yaml.Unmarshal(data, &p); err == nil && p.ID != "" {
			return p, nil
		}
		var ps []models.Project
		if err := yaml.Unmarshal(data, &ps); err == nil && len(ps) > 0 {
			return ps[0], nil
		}
		return models.Project{}, fmt.Errorf("no project found in file")
	}
	var p models.Project
	if err := json.Unmarshal(data, &p); err == nil && p.ID != "" {
		return p, nil
	}
	var ps []models.Project
	if err := json.Unmarshal(data, &ps); err == nil && len(ps) > 0 {
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
