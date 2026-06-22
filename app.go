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
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"gopkg.in/yaml.v3"
)

// ansiRe matches ANSI/VT escape sequences emitted by PTY-attached processes.
var ansiRe = regexp.MustCompile(`\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`)

type Shortcut struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	CommandIDs []string `json:"commandIds"`
}

type Project struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	WorkingDir string            `json:"workingDir"`
	Groups     []string          `json:"groups"`
	GroupPaths map[string]string `json:"groupPaths,omitempty"`
	Commands   []CommandConfig   `json:"commands"`
	Shortcuts  []Shortcut        `json:"shortcuts,omitempty"`
}

type PostCommand struct {
	Command string `json:"command"`
	Timeout int    `json:"timeout,omitempty"` // seconds; 0 = default (120)
}

type CommandConfig struct {
	ID           string        `json:"id"`
	Label        string        `json:"label"`
	Command      string        `json:"command"`
	Group        string        `json:"group"`
	WorkingDir   string        `json:"workingDir,omitempty"`
	PreCommands  []string      `json:"preCommands,omitempty"`
	PostCommands []PostCommand `json:"postCommands,omitempty"`
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

// UpdateProject updates the name and working directory of a single project by ID.
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

// runShellCommandCtx runs one shell command synchronously, streaming output via emit.
// It uses a PTY so the child process sees a terminal and stays line-buffered.
// Cancelling ctx sends SIGTERM to the process (used for post-hook timeouts).
func (a *App) runShellCommandCtx(ctx context.Context, cmdID, shellCmd, workDir string, emit func(string)) (int, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "zsh"
	}
	// -l (login) sources /etc/zprofile + ~/.zprofile so Homebrew PATH is available.
	c := exec.Command(shell, "-l", "-c", shellCmd)
	c.Dir = workDir

	ptmx, err := pty.Start(c)
	if err != nil {
		return -1, fmt.Errorf("pty start: %w", err)
	}
	defer ptmx.Close()

	a.processesMu.Lock()
	a.processes[cmdID] = c
	a.processesMu.Unlock()

	// Kill process when ctx is cancelled (timeout or main-command failure).
	killerCtx, stopKiller := context.WithCancel(context.Background())
	defer stopKiller()
	go func() {
		select {
		case <-ctx.Done():
			pgid := c.Process.Pid
			_ = syscall.Kill(-pgid, syscall.SIGTERM)
		case <-killerCtx.Done():
		}
	}()

	// PTY merges stdout+stderr; strip \r and ANSI escapes.
	scanner := bufio.NewScanner(ptmx)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		line = ansiRe.ReplaceAllString(line, "")
		emit(line)
	}
	stopKiller() // process exited naturally; stop killer goroutine

	err = c.Wait()

	a.processesMu.Lock()
	delete(a.processes, cmdID)
	a.processesMu.Unlock()

	if ctx.Err() != nil {
		return -1, fmt.Errorf("timed out or cancelled")
	}
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode(), nil
		}
		return -1, err
	}
	return 0, nil
}

func (a *App) runShellCommand(cmdID, shellCmd, workDir string, emit func(string)) (int, error) {
	return a.runShellCommandCtx(context.Background(), cmdID, shellCmd, workDir, emit)
}

// ExecuteCommand starts a command (after running any pre-hooks) and streams stdout+stderr as Wails events.
// runID scopes all events to this specific invocation so stale events from a prior run can never
// clear the Stop button while a new run is still active.
// Events emitted:
//
//	"output:<cmdID>:<runID>"    string        — one line of output
//	"done:<cmdID>:<runID>"      CommandResult — main process exit info
//	"post-done:<cmdID>:<runID>" CommandResult — post-hooks exit info (only if PostCommands set)
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

	outEvent      := "output:" + cmd.ID + ":" + runID
	doneEvent     := "done:" + cmd.ID + ":" + runID
	postDoneEvent := "post-done:" + cmd.ID + ":" + runID

	emit := func(line string) {
		if ctx != nil {
			wailsRuntime.EventsEmit(ctx, outEvent, line)
		}
	}

	go func() {
		if len(cmd.PostCommands) == 0 {
			// Original behaviour: pre-hooks + main command in one PTY session so that
			// environment changes in pre-hooks (eval, export, source, direnv) carry
			// into the main command.
			var script strings.Builder
			script.WriteString("set -e\n")
			for i, preCmd := range cmd.PreCommands {
				escaped := strings.ReplaceAll(preCmd, "'", `'\''`)
				fmt.Fprintf(&script, "echo '[PRE] %d/%d: %s'\n", i+1, len(cmd.PreCommands), escaped)
				script.WriteString(preCmd + "\n")
			}
			script.WriteString(cmd.Command + "\n")

			exitCode, err := a.runShellCommand(cmd.ID, script.String(), workDir, emit)
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
			return
		}

		// Has post-hooks: pre-hooks run first (separately), then main starts non-blocking,
		// then post-hooks run concurrently with main (with per-hook timeout).
		// Post-hooks are cancelled automatically if main exits with an error.

		// 1. Pre-hooks (if any) — separate PTY session
		if len(cmd.PreCommands) > 0 {
			var preScript strings.Builder
			preScript.WriteString("set -e\n")
			for i, preCmd := range cmd.PreCommands {
				escaped := strings.ReplaceAll(preCmd, "'", `'\''`)
				fmt.Fprintf(&preScript, "echo '[PRE] %d/%d: %s'\n", i+1, len(cmd.PreCommands), escaped)
				preScript.WriteString(preCmd + "\n")
			}
			exitCode, err := a.runShellCommand(cmd.ID, preScript.String(), workDir, emit)
			if err != nil || exitCode != 0 {
				result := CommandResult{ExitCode: exitCode}
				if err != nil {
					result.ExitCode = -1
					result.Error = err.Error()
				}
				if ctx != nil {
					wailsRuntime.EventsEmit(ctx, doneEvent, result)
					wailsRuntime.EventsEmit(ctx, postDoneEvent, result)
				}
				return
			}
		}

		// 2. Start main command in a background goroutine (may run forever, e.g. emulator).
		mainFailed := make(chan struct{}, 1)
		go func() {
			exitCode, err := a.runShellCommand(cmd.ID, cmd.Command, workDir, emit)
			result := CommandResult{ExitCode: exitCode}
			if err != nil {
				result.ExitCode = -1
				result.Error = err.Error()
			}
			if result.ExitCode != 0 {
				select {
				case mainFailed <- struct{}{}:
				default:
				}
			}
			if ctx != nil {
				wailsRuntime.EventsEmit(ctx, doneEvent, result)
			}
		}()

		// 3. Cancel post-hooks when main fails/stops.
		postCtx, cancelPost := context.WithCancel(context.Background())
		defer cancelPost()
		go func() {
			select {
			case <-mainFailed:
				cancelPost()
			case <-postCtx.Done():
			}
		}()

		// 4. Run post-hooks sequentially with timeout.
		const defaultTimeoutSec = 120
		postExitCode := 0
		postErrStr := ""

		for i, postCmd := range cmd.PostCommands {
			if postCtx.Err() != nil {
				postExitCode = -1
				postErrStr = "main command failed or stopped"
				break
			}

			timeoutSec := postCmd.Timeout
			if timeoutSec <= 0 {
				timeoutSec = defaultTimeoutSec
			}

			emit(fmt.Sprintf("[POST] %d/%d: %s", i+1, len(cmd.PostCommands), postCmd.Command))

			tCtx, cancel := context.WithTimeout(postCtx, time.Duration(timeoutSec)*time.Second)
			exitCode, err := a.runShellCommandCtx(tCtx, cmd.ID+":post", postCmd.Command, workDir, emit)
			cancel()

			if postCtx.Err() != nil {
				postExitCode = -1
				postErrStr = "main command failed or stopped"
				break
			}
			if err != nil {
				postExitCode = -1
				postErrStr = err.Error()
				break
			}
			if exitCode != 0 {
				postExitCode = exitCode
				break
			}
		}

		if ctx != nil {
			result := CommandResult{ExitCode: postExitCode}
			if postErrStr != "" {
				result.Error = postErrStr
			}
			wailsRuntime.EventsEmit(ctx, postDoneEvent, result)
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

// ExportProject opens a save dialog and writes a single project to the chosen file (JSON or YAML).
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
