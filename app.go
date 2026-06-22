package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"gopkg.in/yaml.v3"
)

type Project struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	WorkingDir string          `json:"workingDir"`
	Groups     []string        `json:"groups"`
	Commands   []CommandConfig `json:"commands"`
}

type CommandConfig struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	Command     string   `json:"command"`
	Group       string   `json:"group"`
	WorkingDir  string   `json:"workingDir,omitempty"`
	PreCommands []string `json:"preCommands,omitempty"`
}

type CommandResult struct {
	ExitCode int    `json:"exitCode"`
	Error    string `json:"error,omitempty"`
}

type App struct {
	ctx         context.Context
	ctxMu       sync.RWMutex
	processes   map[string]*exec.Cmd
	processesMu sync.RWMutex
}

func NewApp() *App {
	return &App{
		processes: make(map[string]*exec.Cmd),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctxMu.Lock()
	a.ctx = ctx
	a.ctxMu.Unlock()
}

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

// runShellCommand runs one shell command synchronously, streaming output via emit.
// It uses a PTY so the child process sees a terminal and stays line-buffered —
// request logs and other incremental output appear immediately instead of being
// held in the OS pipe buffer. It registers the process in a.processes[cmdID]
// while running and removes it on exit.
func (a *App) runShellCommand(cmdID, shellCmd, workDir string, emit func(string)) (int, error) {
	c := exec.Command("sh", "-c", shellCmd)
	c.Dir = workDir

	ptmx, err := pty.Start(c)
	if err != nil {
		return -1, fmt.Errorf("pty start: %w", err)
	}
	defer ptmx.Close()

	a.processesMu.Lock()
	a.processes[cmdID] = c
	a.processesMu.Unlock()

	// PTY merges stdout+stderr into one stream; strip the \r that PTY adds before \n.
	scanner := bufio.NewScanner(ptmx)
	for scanner.Scan() {
		emit(strings.TrimRight(scanner.Text(), "\r"))
	}
	// scanner stops on EOF/EIO when the process exits — that is expected.

	err = c.Wait()

	a.processesMu.Lock()
	delete(a.processes, cmdID)
	a.processesMu.Unlock()

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode(), nil
		}
		return -1, err
	}
	return 0, nil
}

// ExecuteCommand starts a command (after running any pre-hooks) and streams stdout+stderr as Wails events.
// runID scopes all events to this specific invocation so stale events from a prior run can never
// clear the Stop button while a new run is still active.
// Events emitted:
//
//	"output:<cmdID>:<runID>" string        — one line of output
//	"done:<cmdID>:<runID>"   CommandResult — process exit info
func (a *App) ExecuteCommand(cmd CommandConfig, workingDir string, runID string) string {
	a.ctxMu.RLock()
	ctx := a.ctx
	a.ctxMu.RUnlock()

	// Kill any prior run of this command
	a.processesMu.Lock()
	if prior, ok := a.processes[cmd.ID]; ok {
		_ = prior.Process.Signal(syscall.SIGTERM)
		delete(a.processes, cmd.ID)
	}
	a.processesMu.Unlock()

	workDir := cmd.WorkingDir
	if workDir == "" {
		workDir = workingDir
	}

	outEvent := "output:" + cmd.ID + ":" + runID
	doneEvent := "done:" + cmd.ID + ":" + runID

	emit := func(line string) {
		if ctx != nil {
			wailsRuntime.EventsEmit(ctx, outEvent, line)
		}
	}

	go func() {
		// Run pre-hook commands sequentially; abort on any failure
		for i, preCmd := range cmd.PreCommands {
			emit(fmt.Sprintf("[PRE] %d/%d: %s", i+1, len(cmd.PreCommands), preCmd))
			exitCode, err := a.runShellCommand(cmd.ID, preCmd, workDir, emit)
			if err != nil {
				if ctx != nil {
					wailsRuntime.EventsEmit(ctx, doneEvent, CommandResult{ExitCode: -1, Error: "pre-hook error: " + err.Error()})
				}
				return
			}
			if exitCode != 0 {
				if ctx != nil {
					wailsRuntime.EventsEmit(ctx, doneEvent, CommandResult{
						ExitCode: exitCode,
						Error:    fmt.Sprintf("pre-hook %d/%d failed (exit %d)", i+1, len(cmd.PreCommands), exitCode),
					})
				}
				return
			}
		}

		// Run the main command
		exitCode, err := a.runShellCommand(cmd.ID, cmd.Command, workDir, emit)
		result := CommandResult{}
		if err != nil {
			result.ExitCode = -1
			result.Error = err.Error()
		} else {
			result.ExitCode = exitCode
		}
		if ctx != nil {
			wailsRuntime.EventsEmit(ctx, doneEvent, result)
		}
	}()

	return "started"
}

// StopCommand kills the process group (SIGTERM → SIGKILL after 3s).
// Using process group (-pgid) ensures child processes spawned by the shell are also terminated.
func (a *App) StopCommand(cmdID string) string {
	a.processesMu.RLock()
	c, ok := a.processes[cmdID]
	a.processesMu.RUnlock()

	if !ok {
		return "not running"
	}

	pgid := c.Process.Pid // PTY Setsid guarantees pgid == pid
	if err := syscall.Kill(-pgid, syscall.SIGTERM); err != nil {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		return "killed"
	}

	go func() {
		time.Sleep(3 * time.Second)
		a.processesMu.RLock()
		_, stillRunning := a.processes[cmdID]
		a.processesMu.RUnlock()
		if stillRunning {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
	}()

	return "stopping"
}

// PickFolder opens a native macOS folder picker.
func (a *App) PickFolder() string {
	a.ctxMu.RLock()
	ctx := a.ctx
	a.ctxMu.RUnlock()

	path, err := wailsRuntime.OpenDirectoryDialog(ctx, wailsRuntime.OpenDialogOptions{
		Title: "Select project folder",
	})
	if err != nil {
		log.Printf("[PickFolder] %v", err)
		return ""
	}
	return path
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

// ExportProjects opens a save dialog and writes all projects to the chosen file (JSON or YAML).
func (a *App) ExportProjects() (string, error) {
	a.ctxMu.RLock()
	ctx := a.ctx
	a.ctxMu.RUnlock()

	path, err := wailsRuntime.SaveFileDialog(ctx, wailsRuntime.SaveDialogOptions{
		Title:           "Export Projects",
		DefaultFilename: "nicosia-projects.json",
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
