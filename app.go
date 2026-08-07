package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
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
	// The name peers see follows the setting, and keeps following it: someone
	// who renames themselves mid-session should not have to restart the app to
	// stop being "Rexy.local" to the person sitting next to them.
	a.share.SetLocalName(set.Get().Username)
	set.OnChange(func(s models.Settings) { a.share.SetLocalName(s.Username) })

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

// GetDefaultDeviceName returns the hostname this device falls back to when no
// username is set. Settings shows it as the field's placeholder, so the user
// can see what peers call them today instead of having to ask someone else.
func (a *App) GetDefaultDeviceName() string {
	return share.LocalName()
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
// scope is "app" for every project or "project" for one. No code is passed: the
// connection step already established who this is, and the far end refuses a
// transfer from anyone it has not let in. Returns "ok" or "error: …".
func (a *App) InitiateShare(peerID, scope, projectID string) string {
	payload, offer, err := a.buildShare(scope, projectID)
	if err != nil {
		return "error: " + err.Error()
	}

	ctx, cancel := context.WithTimeout(a.getCtx(), shareSendTimeout)
	defer cancel()

	if err := a.share.Send(ctx, peerID, offer, payload); err != nil {
		return "error: " + err.Error()
	}
	return "ok"
}

// NewConnectionCode returns a fresh code for the user to read out.
//
// Generation is local and has nothing to do with the network, so the sender's
// dialog can show the code the instant it opens rather than after a round trip
// — the other person is usually already waiting on the phone.
func (a *App) NewConnectionCode() string {
	code, err := share.GeneratePIN()
	if err != nil {
		return ""
	}
	return code
}

// ConnectToPeer asks a peer to connect, and blocks until that device's user has
// typed the code. Returns "ok" or "error: …".
//
// Only the code's hash goes over the wire — see share.RequestConnect.
func (a *App) ConnectToPeer(peerID, code string) string {
	ctx, cancel := context.WithTimeout(a.getCtx(), connectTimeout)
	defer cancel()

	if err := a.share.RequestConnect(ctx, peerID, code); err != nil {
		return "error: " + err.Error()
	}
	return "ok"
}

// AnswerConnectRequest submits a code typed into the connection prompt.
//
// Returns "ok", "expired" when the request is no longer waiting, or
// "wrong: <attempts left>" — the count is returned rather than kept quiet so
// the dialog can warn before the last try rather than after it.
func (a *App) AnswerConnectRequest(requestID, code string) string {
	matched, remaining, found := a.share.AnswerConnect(requestID, code)
	switch {
	case !found:
		return "expired"
	case matched:
		return "ok"
	default:
		return fmt.Sprintf("wrong: %d", remaining)
	}
}

// DeclineConnectRequest refuses a pending connection request.
func (a *App) DeclineConnectRequest(requestID string) string {
	if !a.share.DeclineConnect(requestID) {
		return "expired"
	}
	return "ok"
}

// DisconnectPeer closes a connection that was accepted earlier, so that device
// has to ask again before it can send anything.
func (a *App) DisconnectPeer(peerID string) string {
	a.share.DismissConnect(peerID)
	return "ok"
}

// PickFilesToShare opens a native multi-select picker for arbitrary files.
// Cancelling and failing both yield an empty slice, never nil.
func (a *App) PickFilesToShare() []string {
	paths, err := wailsRuntime.OpenMultipleFilesDialog(a.getCtx(), wailsRuntime.OpenDialogOptions{
		Title: "Choose files to send",
	})
	if err != nil {
		log.Printf("[PickFilesToShare] %v", err)
		return []string{}
	}
	if paths == nil {
		return []string{}
	}
	return paths
}

// InitiateFileShare sends files off this machine's disk to a peer.
//
// Separate from InitiateShare rather than another scope on it because the two
// take different arguments and build entirely different payloads; folding them
// together would mean a signature where half the parameters are always empty.
func (a *App) InitiateFileShare(peerID string, paths []string) string {
	files, err := share.PrepareFiles(paths)
	if err != nil {
		return "error: " + err.Error()
	}

	var total int64
	names := make([]string, 0, len(files))
	for _, f := range files {
		total += f.Size
		names = append(names, f.Name)
	}

	offer := models.ShareOffer{
		TransferID: fmt.Sprintf("%d", time.Now().UnixNano()),
		Scope:      share.ScopeFiles,
		FileNames:  names,
		TotalBytes: total,
	}
	payload := models.SharePayload{Scope: share.ScopeFiles, Files: files}

	ctx, cancel := context.WithTimeout(a.getCtx(), fileSendTimeout)
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

// fileSendTimeout is longer because the payload can be tens of megabytes and
// the decision wait sits in front of it either way.
const fileSendTimeout = 12 * time.Minute

// connectTimeout bounds a connection request. There is a person deciding at the
// other end, so it is measured in the same minutes as a transfer rather than in
// network round trips.
const connectTimeout = 3 * time.Minute

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

// applySharedPayload applies a received payload. Runs on a libp2p handler
// goroutine, after the user has accepted.
//
// A files payload is written to disk and nothing else; it never touches config,
// and config is never written from a files transfer. Which one it is comes from
// the payload's own scope rather than from which fields happen to be populated,
// so a payload claiming to be config cannot smuggle files past the prompt the
// user actually saw.
func (a *App) applySharedPayload(p models.SharePayload) string {
	if p.Scope == share.ScopeFiles {
		return a.saveSharedFiles(p.Files)
	}

	summary, err := a.cfg.ImportProjectsFromSlice(p.Projects)
	if err != nil {
		return "Import failed: " + err.Error()
	}
	return summary
}

// saveSharedFiles writes received files and reports where they went — the path
// is the whole point of the summary, since a file the user cannot find is one
// they did not receive.
func (a *App) saveSharedFiles(files []models.SharedFile) string {
	if len(files) == 0 {
		return "Received nothing"
	}

	dir, err := share.ReceiveDir()
	if err != nil {
		return "Could not save files: " + err.Error()
	}
	written, err := share.SaveFiles(dir, files)
	if err != nil {
		if len(written) == 0 {
			return "Could not save files: " + err.Error()
		}
		return fmt.Sprintf("Saved %d of %d file(s) to %s — %v",
			len(written), len(files), dir, err)
	}

	if len(written) == 1 {
		return "Saved " + filepath.Base(written[0]) + " to " + dir
	}
	return fmt.Sprintf("Saved %d files to %s", len(written), dir)
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
