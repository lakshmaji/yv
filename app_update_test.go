package main

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"yv/internal/models"
	"yv/internal/updater"
)

// A check and a download must not run on top of each other. The UI disables its
// buttons, but the menu item and the dialog reach the same calls, and two
// downloads writing one .part file is not something to leave to the UI.
func TestOnlyOneUpdateOperationAtATime(t *testing.T) {
	u := newAppUpdater("0.1.0")

	if !u.begin() {
		t.Fatal("could not claim an idle updater")
	}
	if u.begin() {
		t.Error("claimed the updater twice")
	}
	u.end()
	if !u.begin() {
		t.Error("could not reclaim the updater after end()")
	}
	u.end()
}

func TestUpdateClaimIsRaceFree(t *testing.T) {
	u := newAppUpdater("0.1.0")

	var wins int
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if u.begin() {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if wins != 1 {
		t.Errorf("%d goroutines claimed the updater, want exactly 1", wins)
	}
}

// publishUpdate records before it emits, so a dialog opening a moment later can
// be handed the current position instead of starting blank. A state that was
// only emitted is one nobody can ask about.
func TestPublishedStateIsReadableAfterwards(t *testing.T) {
	a := &App{upd: newAppUpdater("0.1.0")}

	a.publishUpdate(models.UpdateState{
		Status:        models.UpdateAvailable,
		Version:       "0.2.0",
		Notes:         "some notes",
		CanSelfUpdate: true,
	})

	got := a.GetUpdateState()
	if got.Status != models.UpdateAvailable {
		t.Errorf("status = %q, want available", got.Status)
	}
	if got.Version != "0.2.0" {
		t.Errorf("version = %q, want 0.2.0", got.Version)
	}
	// Stamped by publishUpdate rather than by every caller, so no producer can
	// forget it.
	if got.Current != "0.1.0" {
		t.Errorf("current = %q, want the running version", got.Current)
	}
}

func TestInitialStateNamesTheRunningVersion(t *testing.T) {
	a := &App{upd: newAppUpdater("1.2.3")}
	got := a.GetUpdateState()
	if got.Status != models.UpdateIdle {
		t.Errorf("status = %q, want idle", got.Status)
	}
	if got.Current != "1.2.3" {
		t.Errorf("current = %q, want 1.2.3", got.Current)
	}
}

// Restarting with nothing downloaded must be refused rather than proceeding to
// apply an empty path.
func TestRestartWithoutADownloadIsRefused(t *testing.T) {
	a := &App{upd: newAppUpdater("0.1.0")}

	got := a.RestartToUpdate()
	if !strings.Contains(got, "error:") {
		t.Errorf("RestartToUpdate = %q, want an error", got)
	}
	if a.UpdateInProgress() {
		t.Error("a refused restart left the app blocking quit")
	}
}

// UpdateInProgress is what stops main.go quitting mid-swap, so it has to be
// false at rest — otherwise the app can never be closed.
func TestUpdateNotInProgressAtRest(t *testing.T) {
	a := &App{upd: newAppUpdater("0.1.0")}
	if a.UpdateInProgress() {
		t.Error("a fresh app reports an update in progress")
	}
}

// A dev build must say so and generate no traffic. The check would refuse it
// anyway, but the message is the point: "development build" sends someone to
// how they installed it, where a silent no-op sends them nowhere.
func TestDevBuildReportsItself(t *testing.T) {
	a := &App{upd: newAppUpdater("dev")}

	a.runCheck(false)

	got := a.GetUpdateState()
	if got.Status != models.UpdateDev {
		t.Fatalf("status = %q, want dev", got.Status)
	}
	if !strings.Contains(got.Message, "development build") {
		t.Errorf("message = %q, want one naming a development build", got.Message)
	}
}

// The startup check is silent about everything the user did not ask about. An
// alert saying "you are up to date" four seconds after launch, every launch, is
// the fastest way to make someone turn the feature off.
func TestSilentCheckStaysQuietOnADevBuild(t *testing.T) {
	a := &App{upd: newAppUpdater("dev")}

	a.runCheck(true)

	if got := a.GetUpdateState().Status; got != models.UpdateIdle {
		t.Errorf("a silent check published %q, want to have stayed idle", got)
	}
}

// The three check failures are different advice — wait, check your connection,
// something is wrong — and collapsing them makes the two recoverable ones look
// like the third.
func TestCheckFailureMessages(t *testing.T) {
	tests := []struct {
		name     string
		err      error
		wantSays string
	}{
		{"rate limited", updater.ErrRateLimited, "rate limiting"},
		{"no artifact yet", updater.ErrNoAsset, "does not include a download"},
		{"unsigned release", updater.ErrUnsigned, "not signed"},
		{"timed out", context.DeadlineExceeded, "timed out"},
		{"something else", errors.New("dns exploded"), "dns exploded"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := checkFailureMessage(tt.err)
			if !strings.Contains(got, tt.wantSays) {
				t.Errorf("checkFailureMessage(%v) = %q, want one containing %q", tt.err, got, tt.wantSays)
			}
			// Every one of these is shown verbatim, so none may be empty and
			// none may leak a bare Go error shape.
			if got == "" || strings.HasPrefix(got, "%!") {
				t.Errorf("message is not presentable: %q", got)
			}
		})
	}
}

// "The network gave up" and "these are not our bytes" are worth telling apart:
// one is worth retrying and the other is worth reporting.
func TestDownloadFailureMessages(t *testing.T) {
	tests := []struct {
		name     string
		err      error
		wantSays string
	}{
		{"checksum mismatch", updater.ErrChecksumMismatch, "did not match"},
		{"no key in this build", updater.ErrNoTrustedKey, "cannot verify"},
		{"unsigned release", updater.ErrUnsigned, "not signed"},
		{"cancelled", context.Canceled, "cancelled"},
		{"something else", errors.New("connection reset"), "connection reset"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := downloadFailureMessage(tt.err)
			if !strings.Contains(got, tt.wantSays) {
				t.Errorf("downloadFailureMessage(%v) = %q, want one containing %q", tt.err, got, tt.wantSays)
			}
		})
	}
}

// Downloading without a preceding check is refused. The check is what resolves
// the sidecars, so there is nothing to verify against without one.
func TestDownloadWithoutACheckIsRefused(t *testing.T) {
	a := &App{upd: newAppUpdater("0.1.0")}

	a.runDownload()

	got := a.GetUpdateState()
	// On a machine where this test binary cannot self-update — which is every
	// machine, since it is not an app bundle — the install check refuses first.
	// Either refusal is correct; what must not happen is a download starting.
	if got.Status != models.UpdateFailed && got.Status != models.UpdateManual {
		t.Errorf("status = %q, want failed or manual", got.Status)
	}
	if got.Status == models.UpdateDownloading {
		t.Error("started a download with nothing checked")
	}
}
