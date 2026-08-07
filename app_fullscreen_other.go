//go:build !darwin

package main

import "context"

// startFullscreenMonitor does nothing off macOS.
//
// The monitor exists for one reason: on macOS the header rows reserve space for
// the traffic light buttons, which auto-hide in fullscreen, so the padding has
// to follow the window state. No other platform draws those buttons, so there
// is no state worth watching.
//
// Polling for it on Linux was actively harmful. wailsRuntime.WindowIsFullscreen
// reaches gdk_window_get_state, which asserts on the GTK main thread; called
// from a goroutine every 300ms it printed
//
//	Gdk-CRITICAL **: gdk_window_get_state: assertion 'GDK_IS_WINDOW (window)' failed
//
// three times a second for the life of the process, burying anything real in the
// app's own output. The frontend simply never receives "fullscreen-changed"
// here and body.fullscreen stays off, which is the correct rendering anyway.
func (a *App) startFullscreenMonitor(ctx context.Context) {}
