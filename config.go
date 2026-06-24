package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"gopkg.in/yaml.v3"
)

func configPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("UserConfigDir: %w", err)
	}
	appDir := filepath.Join(dir, "nicosia")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		return "", fmt.Errorf("MkdirAll: %w", err)
	}
	return filepath.Join(appDir, "projects.json"), nil
}

func (a *App) LoadProjects() []Project {
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

	var projects []Project
	if err := json.Unmarshal(data, &projects); err != nil {
		log.Printf("[LoadProjects] parse: %v", err)
		return defaultProjects()
	}
	return projects
}

func (a *App) SaveProjects(projects []Project) string {
	path, err := configPath()
	if err != nil {
		return "error: " + err.Error()
	}
	if err := writeProjects(path, projects); err != nil {
		return "error: " + err.Error()
	}
	return "ok"
}

func (a *App) UpdateProject(projectID, name, workingDir string) string {
	projects := a.LoadProjects()
	for i, p := range projects {
		if p.ID == projectID {
			projects[i].Name = name
			projects[i].WorkingDir = workingDir
			return a.SaveProjects(projects)
		}
	}
	return "error: project not found"
}

func writeProjects(path string, projects []Project) error {
	data, err := json.MarshalIndent(projects, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func marshalProjects(projects []Project, ext string) ([]byte, error) {
	if ext == ".yaml" || ext == ".yml" {
		return yaml.Marshal(projects)
	}
	return json.MarshalIndent(projects, "", "  ")
}

func unmarshalProjects(data []byte, ext string) ([]Project, error) {
	var projects []Project
	if ext == ".yaml" || ext == ".yml" {
		err := yaml.Unmarshal(data, &projects)
		return projects, err
	}
	err := json.Unmarshal(data, &projects)
	return projects, err
}

// unmarshalOneProject parses a single Project from JSON or YAML.
// Accepts either a single object or an array (takes the first element).
func unmarshalOneProject(data []byte, ext string) (Project, error) {
	if ext == ".yaml" || ext == ".yml" {
		var p Project
		if err := yaml.Unmarshal(data, &p); err == nil && p.ID != "" {
			return p, nil
		}
		var ps []Project
		if err := yaml.Unmarshal(data, &ps); err == nil && len(ps) > 0 {
			return ps[0], nil
		}
		return Project{}, fmt.Errorf("no project found in file")
	}
	var p Project
	if err := json.Unmarshal(data, &p); err == nil && p.ID != "" {
		return p, nil
	}
	var ps []Project
	if err := json.Unmarshal(data, &ps); err == nil && len(ps) > 0 {
		return ps[0], nil
	}
	return Project{}, fmt.Errorf("no project found in file")
}

// ExportProject opens a save dialog and writes a single project to a file.
// format must be "json" or "yaml" — callers choose explicitly so no file-dialog
// filter ambiguity exists on macOS.
func (a *App) ExportProject(projectID, format string) (string, error) {
	a.ctxMu.RLock()
	ctx := a.ctx
	a.ctxMu.RUnlock()

	var p *Project
	for _, proj := range a.LoadProjects() {
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
func (a *App) ExportProjects() (string, error) {
	a.ctxMu.RLock()
	ctx := a.ctx
	a.ctxMu.RUnlock()

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
	out, err := marshalProjects(a.LoadProjects(), ext)
	if err != nil {
		return "", err
	}
	return path, os.WriteFile(path, out, 0o644)
}

// ImportProjects opens an open dialog, reads the chosen file, and merges new projects (by ID) into the config.
func (a *App) ImportProjects() (string, error) {
	a.ctxMu.RLock()
	ctx := a.ctx
	a.ctxMu.RUnlock()

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

	existing := a.LoadProjects()
	seen := make(map[string]bool, len(existing))
	for _, p := range existing {
		seen[p.ID] = true
	}

	added, skipped := 0, 0
	for _, p := range incoming {
		if seen[p.ID] {
			skipped++
		} else {
			existing = append(existing, p)
			added++
		}
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
func (a *App) ImportProject() (string, error) {
	a.ctxMu.RLock()
	ctx := a.ctx
	a.ctxMu.RUnlock()

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

	existing := a.LoadProjects()
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

func defaultProjects() []Project {
	return []Project{
		{
			ID:         "pos",
			Name:       "POS",
			WorkingDir: "/Users/lakshmaji/conductor/workspaces/pos-redeem-gf-v1/hot-updater-integration/pos-app/android",
			Groups:     []string{"Android"},
			Commands: []CommandConfig{
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
