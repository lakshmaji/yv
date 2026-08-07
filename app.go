package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"yv/internal/audio"
	"yv/internal/config"
	"yv/internal/env"
	"yv/internal/metrics"
	"yv/internal/models"
	"yv/internal/monitor"
	"yv/internal/runner"
	"yv/internal/settings"
	"yv/internal/share"
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
	share   *share.Node
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

	a := &App{
		runner:  r,
		cfg:     config.NewStore(),
		mon:     monitor.NewMonitor(r, mx),
		envs:    env.NewStore(),
		set:     set,
		metrics: mx,
	}

	// The share node is constructed here but opens no socket until
	// StartDiscovery, so a user who never visits the Discovery view never puts
	// this machine on the network.
	a.share = share.New(a.applySharedPayload)
	a.share.SetPIN(set.Get().SharePIN)
	set.OnChange(func(s models.Settings) { a.share.SetPIN(s.SharePIN) })

	return a
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

// --- Peer sharing ---

// StartDiscovery begins advertising this instance and looking for others on the
// local network. Idempotent, so the Discovery view can mount repeatedly.
func (a *App) StartDiscovery() string {
	if err := a.share.Start(a.getCtx()); err != nil {
		return "error: " + err.Error()
	}
	return "ok"
}

// StopDiscovery takes this instance off the network.
func (a *App) StopDiscovery() string {
	a.share.Stop()
	return "ok"
}

// GetPeers returns the peers already known, so a view that mounts after
// discovery has been running does not have to wait for the next announcement.
func (a *App) GetPeers() []models.PeerInfo {
	peers := a.share.Peers()
	if peers == nil {
		return []models.PeerInfo{}
	}
	return peers
}

// InitiateShare offers config to a peer and streams it if they accept.
//
// scope is "app" for every project or "project" for one. pin is the code the
// target requires, ignored when it requires none. Returns "ok" or "error: …".
func (a *App) InitiateShare(peerID, scope, projectID, pin string) string {
	payload, offer, err := a.buildShare(scope, projectID)
	if err != nil {
		return "error: " + err.Error()
	}
	offer.PIN = pin

	ctx, cancel := context.WithTimeout(a.getCtx(), shareSendTimeout)
	defer cancel()

	if err := a.share.Send(ctx, peerID, offer, payload); err != nil {
		return "error: " + err.Error()
	}
	return "ok"
}

// RespondToShare delivers the user's accept/decline to a waiting transfer.
func (a *App) RespondToShare(transferID string, accept bool) string {
	if !a.share.Respond(transferID, accept) {
		return "error: that transfer is no longer waiting"
	}
	return "ok"
}

// shareSendTimeout bounds a whole outbound transfer, including the time the
// other person spends deciding.
const shareSendTimeout = 3 * time.Minute

// buildShare assembles the payload and its offer header.
//
// Environments are deliberately not included. Secrets live in a separate file
// precisely so they never travel with shared config.
func (a *App) buildShare(scope, projectID string) (models.SharePayload, models.ShareOffer, error) {
	all := a.cfg.LoadProjects()

	var picked []models.Project
	var projectName string

	switch scope {
	case "app":
		picked = all
	case "project":
		for _, p := range all {
			if p.ID == projectID {
				picked = []models.Project{p}
				projectName = p.Name
				break
			}
		}
		if len(picked) == 0 {
			return models.SharePayload{}, models.ShareOffer{}, fmt.Errorf("project not found")
		}
	default:
		return models.SharePayload{}, models.ShareOffer{}, fmt.Errorf("unknown scope %q", scope)
	}

	payload := models.SharePayload{Scope: scope, Projects: picked}
	offer := models.ShareOffer{
		TransferID:   fmt.Sprintf("%d", time.Now().UnixNano()),
		Scope:        scope,
		ProjectName:  projectName,
		ProjectCount: len(picked),
	}
	return payload, offer, nil
}

// applySharedPayload merges a received payload into the local config. Runs on a
// libp2p handler goroutine, after the user has accepted.
func (a *App) applySharedPayload(p models.SharePayload) string {
	summary, err := a.cfg.ImportProjectsFromSlice(p.Projects)
	if err != nil {
		return "Import failed: " + err.Error()
	}
	return summary
}

// --- Audio ---

// PickAudioClips opens a native multi-select picker for sound files. Cancelling
// and failing both yield an empty slice — never nil, so the frontend can spread
// the result without a guard.
func (a *App) PickAudioClips() []string {
	paths, err := wailsRuntime.OpenMultipleFilesDialog(a.getCtx(), wailsRuntime.OpenDialogOptions{
		Title: "Select sound clips",
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "Audio (" + audio.DialogPattern() + ")", Pattern: audio.DialogPattern()},
		},
	})
	if err != nil {
		log.Printf("[PickAudioClips] %v", err)
		return []string{}
	}
	if paths == nil {
		return []string{}
	}
	return paths
}

// GetAudioClip returns a clip as a data URL the webview can play, or "error: …".
// The frontend caches the result per path, so this is called once per clip per
// session rather than on every click.
func (a *App) GetAudioClip(path string) string {
	url, err := audio.Load(path)
	if err != nil {
		return "error: " + err.Error()
	}
	return url
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
