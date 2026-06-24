package main

import (
	"context"
	"log"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"nicosia/internal/config"
	"nicosia/internal/models"
	"nicosia/internal/monitor"
	"nicosia/internal/runner"
)

// App is the Wails-bound facade. All business logic lives in the internal packages;
// methods here are thin wrappers that keep the frontend-visible API stable.
// ctx is written once in startup (before any concurrent calls) so no mutex is needed.
type App struct {
	ctx    context.Context
	runner *runner.Runner
	cfg    *config.Store
	mon    *monitor.Monitor
}

func NewApp() *App {
	r := runner.NewRunner()
	return &App{
		runner: r,
		cfg:    config.NewStore(),
		mon:    monitor.NewMonitor(r),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.mon.Start(ctx)
	a.startFullscreenMonitor(ctx)
}

func (a *App) getCtx() context.Context {
	return a.ctx
}

func (a *App) startFullscreenMonitor(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(300 * time.Millisecond)
		defer ticker.Stop()
		wasFullscreen := false
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				isFs := wailsRuntime.WindowIsFullscreen(ctx)
				if isFs != wasFullscreen {
					wasFullscreen = isFs
					wailsRuntime.EventsEmit(ctx, "fullscreen-changed", isFs)
				}
			}
		}
	}()
}

// StopAllCommands kills all running command processes. Called from main.go on quit.
func (a *App) StopAllCommands() {
	a.runner.StopAll()
}

// PickFolder opens a native macOS folder picker.
func (a *App) PickFolder() string {
	path, err := wailsRuntime.OpenDirectoryDialog(a.getCtx(), wailsRuntime.OpenDialogOptions{
		Title: "Select project folder",
	})
	if err != nil {
		log.Printf("[PickFolder] %v", err)
		return ""
	}
	return path
}

// --- Config delegation ---

func (a *App) LoadProjects() []models.Project {
	return a.cfg.LoadProjects()
}

func (a *App) SaveProjects(projects []models.Project) string {
	return a.cfg.SaveProjects(projects)
}

func (a *App) UpdateProject(projectID, name, workingDir string) string {
	return a.cfg.UpdateProject(projectID, name, workingDir)
}

func (a *App) ExportProject(projectID, format string) (string, error) {
	return a.cfg.ExportProject(a.getCtx(), projectID, format)
}

func (a *App) ExportProjects() (string, error) {
	return a.cfg.ExportProjects(a.getCtx())
}

func (a *App) ImportProjects() (string, error) {
	return a.cfg.ImportProjects(a.getCtx())
}

func (a *App) ImportProject() (string, error) {
	return a.cfg.ImportProject(a.getCtx())
}

// --- Runner delegation ---

func (a *App) ExecuteCommand(cmd models.CommandConfig, workingDir string, runID string) string {
	return a.runner.ExecuteCommand(a.getCtx(), cmd, workingDir, runID)
}

func (a *App) GetRunningCommands() []string {
	return a.runner.GetRunningCommands()
}

func (a *App) SendInput(cmdID string, text string) string {
	return a.runner.SendInput(cmdID, text)
}

func (a *App) StopCommand(cmdID string) string {
	return a.runner.StopCommand(cmdID)
}

// --- Monitor delegation ---

func (a *App) GetResourceStats() models.ResourceStats {
	return a.mon.GetResourceStats()
}
