package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type Project struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	WorkingDir string          `json:"workingDir"`
	Groups     []string        `json:"groups"`
	Commands   []CommandConfig `json:"commands"`
}

type CommandConfig struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Command string `json:"command"`
	Group   string `json:"group"`
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

// ExecuteCommand starts a command and streams stdout+stderr as Wails events.
// Events emitted:
//   "output:<cmdID>" string  — one line of output
//   "done:<cmdID>"   CommandResult — process exit info
func (a *App) ExecuteCommand(cmd CommandConfig, workingDir string) string {
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

	c := exec.Command("sh", "-c", cmd.Command)
	c.Dir = workingDir

	stdoutPipe, err := c.StdoutPipe()
	if err != nil {
		return "pipe error: " + err.Error()
	}
	stderrPipe, err := c.StderrPipe()
	if err != nil {
		return "pipe error: " + err.Error()
	}

	if err := c.Start(); err != nil {
		return "start error: " + err.Error()
	}

	a.processesMu.Lock()
	a.processes[cmd.ID] = c
	a.processesMu.Unlock()

	emit := func(line string) {
		if ctx != nil {
			wailsRuntime.EventsEmit(ctx, "output:"+cmd.ID, line)
		}
	}

	// Stream stdout and stderr concurrently into the same event channel
	var wg sync.WaitGroup
	streamPipe := func(pipe io.ReadCloser) {
		defer wg.Done()
		scanner := bufio.NewScanner(pipe)
		for scanner.Scan() {
			emit(scanner.Text())
		}
	}

	wg.Add(2)
	go streamPipe(stdoutPipe)
	go streamPipe(stderrPipe)

	go func() {
		wg.Wait()
		err := c.Wait()

		a.processesMu.Lock()
		delete(a.processes, cmd.ID)
		a.processesMu.Unlock()

		result := CommandResult{}
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				result.ExitCode = exitErr.ExitCode()
			} else {
				result.ExitCode = -1
				result.Error = err.Error()
			}
		}
		if ctx != nil {
			wailsRuntime.EventsEmit(ctx, "done:"+cmd.ID, result)
		}
	}()

	return "started"
}

// StopCommand sends SIGTERM to the running process; SIGKILL after 3s if still alive.
func (a *App) StopCommand(cmdID string) string {
	a.processesMu.RLock()
	c, ok := a.processes[cmdID]
	a.processesMu.RUnlock()

	if !ok {
		return "not running"
	}

	if err := c.Process.Signal(syscall.SIGTERM); err != nil {
		_ = c.Process.Kill()
		return "killed"
	}

	go func() {
		time.Sleep(3 * time.Second)
		a.processesMu.RLock()
		_, stillRunning := a.processes[cmdID]
		a.processesMu.RUnlock()
		if stillRunning {
			_ = c.Process.Kill()
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
