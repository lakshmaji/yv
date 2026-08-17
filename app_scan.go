package main

import (
	"context"
	"log"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"yv/internal/config"
	"yv/internal/models"
)

const (
	// scanStartDelay is how long after launch the first scan runs. A job set to
	// four hours that has not fired yet is no use to someone who opens the app,
	// works for two hours and quits — but it should not compete with boot either.
	scanStartDelay = 30 * time.Second

	// scanIdle is how often the timer wakes when scanning is switched off. It
	// re-checks the settings and goes back to sleep, which is cheaper in code
	// than stopping the timer and needing a nil-channel dance to restart it.
	scanIdle = time.Hour

	// scanNewEvent carries hits the user has not been asked about yet.
	scanNewEvent = "scan:new"
)

// startScanMonitor walks the configured folder for yv.yaml files on a timer and
// tells the frontend when it finds one the user has not answered for.
//
// It never imports. The only thing this writes is the record of which files the
// user has already been asked about, and that only happens once they answer.
func (a *App) startScanMonitor(ctx context.Context) {
	// Buffered and non-blocking, so the settings observer — which runs inline
	// on whichever goroutine called Save — never waits on this loop.
	reset := make(chan struct{}, 1)
	a.set.OnChange(func(models.Settings) {
		select {
		case reset <- struct{}{}:
		default:
		}
	})

	go func() {
		timer := time.NewTimer(scanStartDelay)
		defer timer.Stop()

		for {
			select {
			case <-ctx.Done():
				return

			case <-reset:
				// A settings change re-arms on the new interval but does not
				// scan: saving Settings four times must not walk the disk four
				// times. Stop can race a timer that has already fired, so the
				// channel is drained before Reset.
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(a.scanEvery())

			case <-timer.C:
				a.runScan(ctx)
				timer.Reset(a.scanEvery())
			}
		}
	}()
}

// scanEvery is the configured interval, or a long idle period when scanning is
// off — runScan then returns immediately, so an off switch costs one wake an
// hour rather than a second piece of timer state.
func (a *App) scanEvery() time.Duration {
	cur := a.set.Get()
	if cur.ScanInterval <= 0 || cur.ScanDir == "" {
		return scanIdle
	}
	return time.Duration(cur.ScanInterval) * time.Minute
}

// runScan performs one background scan and emits anything new.
//
// Silent when there is nothing new to ask about. A four-hourly "found 0 new
// projects" popup is the fastest way to get a feature switched off, and the
// dialog it would open is the same one the user can reach whenever they like.
func (a *App) runScan(ctx context.Context) {
	cur := a.set.Get()
	if cur.ScanInterval <= 0 || cur.ScanDir == "" {
		return
	}

	// Its own deadline: a folder on an unresponsive network mount must not hold
	// this goroutine past the next tick.
	scanCtx, cancel := context.WithTimeout(ctx, config.ScanTimeout)
	defer cancel()

	res := a.cfg.ScanForConfigs(scanCtx, cur.ScanDir)
	if res.Truncated != "" {
		log.Printf("[scan] %s: %s", cur.ScanDir, res.Truncated)
	}

	fresh := a.cfg.UnseenHits(res.Hits)
	if len(fresh) == 0 {
		return
	}
	wailsRuntime.EventsEmit(ctx, scanNewEvent, fresh)
}
