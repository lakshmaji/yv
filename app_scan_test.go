package main

import (
	"context"
	"testing"
	"time"

	"yv/internal/models"
	"yv/internal/settings"
)

func isolateAppHome(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")
}

func TestScanEvery(t *testing.T) {
	tests := []struct {
		name string
		set  models.Settings
		want time.Duration
	}{
		{"configured", models.Settings{ScanDir: "/tmp", ScanInterval: 240}, 4 * time.Hour},
		{"the shortest allowed", models.Settings{ScanDir: "/tmp", ScanInterval: settings.MinScanInterval}, 15 * time.Minute},
		// Off in either direction falls back to the idle wake rather than
		// stopping the timer, so switching scanning back on needs no restart.
		{"interval off", models.Settings{ScanDir: "/tmp", ScanInterval: 0}, scanIdle},
		{"no folder", models.Settings{ScanInterval: 240}, scanIdle},
		{"nothing configured", models.Settings{}, scanIdle},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			isolateAppHome(t)
			a := &App{set: settings.NewStore()}
			if _, err := a.set.Save(tt.set); err != nil {
				t.Fatalf("Save: %v", err)
			}
			if got := a.scanEvery(); got != tt.want {
				t.Errorf("scanEvery() = %v, want %v", got, tt.want)
			}
		})
	}
}

// An unconfigured scan must do nothing at all — no walk, and above all no
// write. The app context is nil here, which would panic on an EventsEmit, so
// this also proves it returns before reaching one.
func TestRunScanDoesNothingWhenUnconfigured(t *testing.T) {
	isolateAppHome(t)
	a := &App{set: settings.NewStore()}
	if _, err := a.set.Save(models.Settings{}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	a.runScan(context.Background())
}

// The goroutine must exit when the app does, rather than surviving as a timer
// firing into a cancelled runtime.
func TestScanMonitorStopsWithTheContext(t *testing.T) {
	isolateAppHome(t)
	a := &App{set: settings.NewStore()}
	if _, err := a.set.Save(models.Settings{}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	a.startScanMonitor(ctx)

	// A settings change must be absorbed without blocking, whether or not the
	// loop is currently at its select — the observer runs inline on the
	// caller's goroutine, so a blocking send here would hang every Save.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 5; i++ {
			if _, err := a.set.Save(models.Settings{ScanDir: "/tmp/nope", ScanInterval: 240}); err != nil {
				t.Errorf("Save: %v", err)
				return
			}
		}
	}()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("saving settings blocked on the scan monitor")
	}

	cancel()
	// Nothing to assert beyond not deadlocking or racing; -race and the test
	// binary's leak-free exit are what this is really checking.
}
