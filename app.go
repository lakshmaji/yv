package main

import (
	"context"
	"log"
	"os"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"yv/internal/config"
	"yv/internal/env"
	"yv/internal/metrics"
	"yv/internal/models"
	"yv/internal/monitor"
	"yv/internal/runner"
	"yv/internal/settings"
)

// App is the Wails-bound facade. All business logic lives in the internal packages;
// methods here are thin wrappers that keep the frontend-visible API stable.
// ctx is written once in startup (before any concurrent calls) so no mutex is needed.
type App struct {
	ctx     context.Context
	runner  *runner.Runner
	cfg     *config.Store
	mon     *monitor.Monitor
	envs    *env.Store
	set     *settings.Store
	metrics *metrics.Store
}

func NewApp() *App {
	r := runner.NewRunner()
	set := settings.NewStore()

	// The metrics store is the sink for both the resource monitor and the
	// runner, and it follows the settings toggle: nothing reaches the disk
	// until the user opts in, and disabling stops collection immediately.
	mx := metrics.NewStore(set.RetentionDays)
	mx.SetEnabled(set.MetricsEnabled())
	r.SetRunSink(mx)
	set.OnChange(func(s models.Settings) { mx.SetEnabled(s.MetricsEnabled) })

	return &App{
		runner:  r,
		cfg:     config.NewStore(),
		mon:     monitor.NewMonitor(r, mx),
		envs:    env.NewStore(),
		set:     set,
		metrics: mx,
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.mon.Start(ctx)
	a.startFullscreenMonitor(ctx)
	// Clean up expired metrics on launch, so a long-idle app prunes without
	// waiting for the first day rollover.
	go func() { _ = a.metrics.Prune(time.Now()) }()
}

// closeMetrics flushes the partial metrics bucket and releases the day files.
// Unexported so it stays out of the generated TypeScript bindings; main.go is
// in the same package and calls it on shutdown.
func (a *App) closeMetrics() {
	_ = a.metrics.Close()
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

// CheckPath returns true if path is an existing readable directory.
// An empty path is considered valid (the runner inherits the parent CWD).
func (a *App) CheckPath(path string) bool {
	if path == "" {
		return true
	}
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
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

func (a *App) UpdateProject(projectID, name, workingDir, labelBgColor, labelTxColor string) string {
	return a.cfg.UpdateProject(projectID, name, workingDir, labelBgColor, labelTxColor)
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

// --- Environment delegation ---

// GetEnvironments returns every environment defined for a project, plus the
// active one. Values are included so the frontend can display and edit them.
func (a *App) GetEnvironments(projectID string) models.ProjectEnvs {
	return a.envs.Get(projectID)
}

// SaveEnvironments replaces a project's environments. Returns "ok" or "error: …",
// matching the convention used by the other save methods.
func (a *App) SaveEnvironments(projectID string, envs models.ProjectEnvs) string {
	if err := a.envs.Save(projectID, envs); err != nil {
		return "error: " + err.Error()
	}
	return "ok"
}

// DeleteEnvironments removes all environments belonging to a project.
func (a *App) DeleteEnvironments(projectID string) string {
	if err := a.envs.Delete(projectID); err != nil {
		return "error: " + err.Error()
	}
	return "ok"
}

// --- Runner delegation ---

// ExecuteCommand runs a command with the active environment of projectID applied.
// Passing an empty projectID runs with no extra environment variables.
func (a *App) ExecuteCommand(cmd models.CommandConfig, workingDir string, runID string, projectID string) string {
	var vars []models.EnvVar
	if projectID != "" {
		vars = a.envs.ActiveVars(projectID)
	}
	return a.runner.ExecuteCommand(a.getCtx(), cmd, workingDir, runID, vars, projectID)
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

// --- Settings delegation ---

// GetSettings returns the global app settings with defaults applied.
func (a *App) GetSettings() models.Settings {
	return a.set.Get()
}

// SaveSettings persists the global settings. Returns "ok" or "error: …".
//
// Turning metrics off takes effect before this returns and does not delete
// anything already collected — ClearMetrics does that.
func (a *App) SaveSettings(s models.Settings) string {
	if _, err := a.set.Save(s); err != nil {
		return "error: " + err.Error()
	}
	return "ok"
}

// --- Metrics delegation ---

// GetMetrics returns pre-aggregated resource series for a bounded time range,
// grouped by command, project, or group. Aggregation happens in Go so the
// frontend never parses raw records.
func (a *App) GetMetrics(req models.MetricsQuery) models.MetricsResult {
	return a.metrics.Query(req)
}

// GetUsageFrequency returns how often commands, projects, or groups were run
// over a bounded range — the run-count counterpart to GetMetrics.
func (a *App) GetUsageFrequency(req models.MetricsQuery) models.FrequencyResult {
	return a.metrics.UsageFrequency(req)
}

// GetActivityHeatmap returns dense per-day run counts for the last `days` days
// (clamped to the retention window) for the calendar heatmap.
func (a *App) GetActivityHeatmap(days int) models.ActivityHeatmap {
	return a.metrics.ActivityHeatmap(days)
}

// ClearMetrics deletes every stored metrics file. Returns "ok" or "error: …".
func (a *App) ClearMetrics() string {
	if err := a.metrics.Clear(); err != nil {
		return "error: " + err.Error()
	}
	return "ok"
}

// GetMetricsStorageInfo reports how much disk the metrics store is using.
func (a *App) GetMetricsStorageInfo() models.MetricsStorageInfo {
	return a.metrics.StorageInfo()
}
