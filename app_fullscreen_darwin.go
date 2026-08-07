//go:build darwin

package main

import (
	"context"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// startFullscreenMonitor polls the window state and emits "fullscreen-changed"
// only on transitions. The frontend uses it to drop the padding that clears the
// macOS traffic light buttons, which auto-hide in fullscreen.
//
// macOS only, deliberately. The Cocoa read is thread-safe enough to poll from a
// goroutine; the GTK equivalent is not — on Linux every tick called
// gdk_window_get_state off the main thread and printed a Gdk-CRITICAL assertion
// failure, 3+ per second for the life of the process. There is nothing to
// reclaim there either: no other platform reserves space for traffic lights.
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
