package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"yv/internal/models"
	"yv/internal/updater"
)

// The Wails-bound half of the updater: the same thin-wrapper role app.go plays
// for every other internal package, plus the small amount of state that has to
// outlive a single call.

// updateEvent carries every state change to the frontend. Registered in App.tsx
// rather than in the dialog, so a state arriving while the dialog is shut is not
// dropped — which is exactly what the startup check does.
const updateEvent = "update:state"

// startupCheckDelay lets the window finish coming up before a background check
// competes for the network and the main thread. Long enough not to be part of
// launch, short enough that someone who opens About immediately sees a settled
// answer rather than a spinner.
const startupCheckDelay = 4 * time.Second

// updateSession is the part of an update that spans calls.
type updateSession struct {
	mu sync.Mutex

	// state is the last thing published. Kept so a dialog opening late can be
	// handed the current position rather than starting blank and waiting for
	// the next event.
	state models.UpdateState

	// pending is a downloaded, verified artifact waiting on a restart. Held in
	// memory only: after a quit, the file is still on disk but there is no
	// longer anything asserting it was verified, and re-verifying it would mean
	// re-fetching the sidecars anyway.
	pending        string
	pendingVersion string

	// busy stops a second check or download from starting on top of the first.
	// The UI disables its buttons, but a menu item and a keyboard shortcut reach
	// the same calls, and two downloads writing one .part file is not something
	// to leave to the UI.
	busy bool

	// applying blocks quit. Exiting between "old bundle moved aside" and "new
	// one renamed into place" is how an install ends up with no application.
	applying bool
}

// GetUpdateState returns the current position, for a dialog that has just opened.
func (a *App) GetUpdateState() models.UpdateState {
	a.upd.session.mu.Lock()
	defer a.upd.session.mu.Unlock()
	return a.upd.session.state
}

// CheckForUpdates looks for a newer release and publishes the outcome.
//
// Returns "ok" or "error: …" like every other bound method, but the answer that
// matters is the event: the check is asynchronous and the caller is a button
// that needs to stop spinning.
func (a *App) CheckForUpdates() string {
	if !a.upd.begin() {
		return "error: an update is already in progress"
	}
	go func() {
		defer a.upd.end()
		a.runCheck(false)
	}()
	return "ok"
}

// DownloadUpdate fetches and verifies the available release.
func (a *App) DownloadUpdate() string {
	if !a.upd.begin() {
		return "error: an update is already in progress"
	}
	go func() {
		defer a.upd.end()
		a.runDownload()
	}()
	return "ok"
}

// RestartToUpdate installs the pending download and relaunches.
//
// It does not return on success — the process is replaced or exits. A returned
// value is therefore always a failure, which is why the state is published
// before anything irreversible starts.
func (a *App) RestartToUpdate() string {
	s := a.upd.session
	s.mu.Lock()
	artifact, version := s.pending, s.pendingVersion
	if artifact == "" {
		s.mu.Unlock()
		return "error: no update has been downloaded"
	}
	s.applying = true
	s.mu.Unlock()

	// Running commands are the user's work, and an update is not a reason to
	// lose it silently. The same dialog quit uses, for the same reason.
	if running := a.GetRunningCommands(); len(running) > 0 {
		answer, err := wailsRuntime.MessageDialog(a.getCtx(), wailsRuntime.MessageDialogOptions{
			Type:          wailsRuntime.QuestionDialog,
			Title:         "Restart to update?",
			Message:       fmt.Sprintf("%d command(s) are still running. They will be stopped.", len(running)),
			Buttons:       []string{"Restart", "Cancel"},
			DefaultButton: "Cancel",
			CancelButton:  "Cancel",
		})
		if err != nil || answer != "Restart" {
			s.mu.Lock()
			s.applying = false
			s.mu.Unlock()
			return "cancelled"
		}
	}

	if err := a.upd.Apply(a.getCtx(), artifact); err != nil {
		s.mu.Lock()
		s.applying = false
		s.mu.Unlock()
		a.publishUpdate(models.UpdateState{
			Status:  models.UpdateFailed,
			Version: version,
			Message: err.Error(),
		})
		return "error: " + err.Error()
	}

	// Past this point the new version is installed and the old one is gone, so
	// there is no state worth preserving and every failure below is about
	// getting the user back into an app that already exists.
	a.StopAllCommands()
	a.closeMetrics()
	a.StopDiscovery()

	if err := a.upd.Relaunch(); err != nil {
		s.mu.Lock()
		s.applying = false
		s.mu.Unlock()
		return "error: yv was updated but could not restart itself — open it again: " + err.Error()
	}
	wailsRuntime.Quit(a.getCtx())
	return "ok"
}

// OpenReleasePage sends the user to the download page. The answer for every
// install that cannot replace itself.
func (a *App) OpenReleasePage() string {
	wailsRuntime.BrowserOpenURL(a.getCtx(), updater.ReleasePage)
	return "ok"
}

// UpdateInProgress reports whether an install is mid-flight, so main.go can
// refuse to quit through it.
func (a *App) UpdateInProgress() bool {
	a.upd.session.mu.Lock()
	defer a.upd.session.mu.Unlock()
	return a.upd.session.applying
}

// ── the work ────────────────────────────────────────────────────────────

// runCheck performs a check and publishes the result.
//
// silent suppresses only the outcomes a user did not ask about: the startup
// check should surface an available update and say nothing at all about being
// up to date, being offline, or being rate limited. Pressing the button reports
// all of them, because then somebody is waiting for an answer.
func (a *App) runCheck(silent bool) {
	install := a.upd.InstallCheck()

	if a.upd.IsDevBuild() {
		if !silent {
			a.publishUpdate(models.UpdateState{
				Status:  models.UpdateDev,
				Message: "This is a development build, so it does not check for updates.",
			})
		}
		return
	}

	if !silent {
		a.publishUpdate(models.UpdateState{Status: models.UpdateChecking, CanSelfUpdate: install.CanSelfUpdate})
	}

	ctx, cancel := context.WithTimeout(a.getCtx(), 30*time.Second)
	defer cancel()

	rel, err := a.upd.Check(ctx)
	switch {
	case errors.Is(err, updater.ErrUpToDate):
		if !silent {
			a.publishUpdate(models.UpdateState{
				Status:        models.UpdateCurrent,
				CanSelfUpdate: install.CanSelfUpdate,
				Message:       "yv is up to date.",
			})
		}
		return
	case err != nil:
		if !silent {
			a.publishUpdate(models.UpdateState{
				Status:        models.UpdateFailed,
				CanSelfUpdate: install.CanSelfUpdate,
				Message:       checkFailureMessage(err),
			})
		}
		return
	}

	// A release exists. Which of the two states depends on whether this install
	// can act on it, and that is decided here rather than in the frontend so
	// there is one place that knows the rule.
	state := models.UpdateState{
		Status:        models.UpdateAvailable,
		Version:       rel.Version,
		Notes:         rel.Notes,
		CanSelfUpdate: install.CanSelfUpdate,
	}
	if !install.CanSelfUpdate {
		state.Status = models.UpdateManual
		state.Message = install.Reason
	} else if !updater.HasTrustedKey() {
		// Said now rather than at the end of the download, which would refuse
		// it anyway.
		state.Status = models.UpdateManual
		state.Message = "This build cannot verify updates, so it will not install one. Download it from the releases page instead."
		state.CanSelfUpdate = false
	}
	a.publishUpdate(state)
}

// checkFailureMessage turns an error into something worth reading.
//
// The three cases are genuinely different advice — wait, check your connection,
// something is wrong — and collapsing them into "update check failed" makes the
// two recoverable ones look like the third.
func checkFailureMessage(err error) string {
	switch {
	case errors.Is(err, updater.ErrRateLimited):
		return "GitHub is rate limiting this network. Try again in a little while."
	case errors.Is(err, updater.ErrNoAsset):
		return "The latest release does not include a download for this platform yet."
	case errors.Is(err, updater.ErrUnsigned):
		return "The latest release is not signed, so it will not be installed."
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return "The update check timed out. Check your connection and try again."
	default:
		return "Could not check for updates: " + err.Error()
	}
}

func (a *App) runDownload() {
	// Re-checked rather than trusting the state published earlier: the dialog
	// may have been open for a while, and the answer can change if the user
	// moved the app in the meantime.
	if install := a.upd.InstallCheck(); !install.CanSelfUpdate {
		a.publishUpdate(models.UpdateState{Status: models.UpdateManual, Message: install.Reason})
		return
	}

	last := a.GetUpdateState()
	if last.Status != models.UpdateAvailable {
		a.publishUpdate(models.UpdateState{
			Status:        models.UpdateFailed,
			CanSelfUpdate: true,
			Message:       "There is no update to download. Check again.",
		})
		return
	}

	// The Release is re-resolved rather than cached from the check, because the
	// sidecars are what make it installable and they were fetched then. Holding
	// them across an arbitrary gap means downloading against a description that
	// may no longer be what is published.
	ctx, cancel := context.WithTimeout(a.getCtx(), 30*time.Second)
	rel, err := a.upd.Check(ctx)
	cancel()
	if err != nil {
		a.publishUpdate(models.UpdateState{
			Status:        models.UpdateFailed,
			CanSelfUpdate: true,
			Message:       checkFailureMessage(err),
		})
		return
	}

	a.publishUpdate(models.UpdateState{
		Status:        models.UpdateDownloading,
		Version:       rel.Version,
		Notes:         rel.Notes,
		Total:         rel.AssetSize,
		CanSelfUpdate: true,
	})

	path, err := a.upd.Download(a.getCtx(), rel, func(p updater.Progress) {
		a.publishUpdate(models.UpdateState{
			Status:        models.UpdateDownloading,
			Version:       rel.Version,
			Notes:         rel.Notes,
			Downloaded:    p.Downloaded,
			Total:         p.Total,
			CanSelfUpdate: true,
		})
	})
	if err != nil {
		a.publishUpdate(models.UpdateState{
			Status:        models.UpdateFailed,
			Version:       rel.Version,
			CanSelfUpdate: true,
			Message:       downloadFailureMessage(err),
		})
		return
	}

	s := a.upd.session
	s.mu.Lock()
	s.pending, s.pendingVersion = path, rel.Version
	s.mu.Unlock()

	a.publishUpdate(models.UpdateState{
		Status:        models.UpdateReady,
		Version:       rel.Version,
		Notes:         rel.Notes,
		Downloaded:    rel.AssetSize,
		Total:         rel.AssetSize,
		CanSelfUpdate: true,
	})
}

// downloadFailureMessage distinguishes "the network gave up" from "these are not
// our bytes", because only one of them is worth retrying and the other is worth
// reporting.
func downloadFailureMessage(err error) string {
	switch {
	case errors.Is(err, updater.ErrChecksumMismatch):
		return "The download did not match its published checksum and was discarded. Try again."
	case errors.Is(err, updater.ErrNoTrustedKey):
		return "This build cannot verify updates, so it will not install one."
	case errors.Is(err, updater.ErrUnsigned):
		return "That release is not signed, so it will not be installed."
	case errors.Is(err, context.Canceled):
		return "The download was cancelled."
	default:
		return "The download failed: " + err.Error()
	}
}

// publishUpdate records the state and pushes it to the frontend.
//
// Recorded first and always, even before the window exists — a state that was
// only emitted is one a dialog opening a second later has no way to learn.
func (a *App) publishUpdate(state models.UpdateState) {
	state.Current = a.upd.Current()

	s := a.upd.session
	s.mu.Lock()
	s.state = state
	s.mu.Unlock()

	if ctx := a.getCtx(); ctx != nil {
		wailsRuntime.EventsEmit(ctx, updateEvent, state)
	}
}

// ── plumbing ────────────────────────────────────────────────────────────

// appUpdater is the updater plus the session state the App holds around it.
type appUpdater struct {
	*updater.Updater
	session *updateSession
}

func newAppUpdater(version string) *appUpdater {
	return &appUpdater{
		Updater: updater.New(version),
		session: &updateSession{state: models.UpdateState{Status: models.UpdateIdle, Current: version}},
	}
}

// begin claims the updater, or reports that something else already has it.
func (u *appUpdater) begin() bool {
	u.session.mu.Lock()
	defer u.session.mu.Unlock()
	if u.session.busy {
		return false
	}
	u.session.busy = true
	return true
}

func (u *appUpdater) end() {
	u.session.mu.Lock()
	u.session.busy = false
	u.session.mu.Unlock()
}

// startUpdateWatch sweeps what a previous update left behind and then checks
// quietly in the background.
//
// The sweep runs on every launch, not only after an update: the leftovers it
// clears are precisely the ones an interrupted update could not clear itself.
func (a *App) startUpdateWatch(ctx context.Context) {
	go func() {
		a.upd.SweepStale()

		select {
		case <-ctx.Done():
			return
		case <-time.After(startupCheckDelay):
		}

		if !a.upd.begin() {
			return
		}
		defer a.upd.end()
		a.runCheck(true)
	}()
}
