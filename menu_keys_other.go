//go:build !windows

package main

import "github.com/wailsapp/wails/v2/pkg/menu/keys"

// The conventional accelerators, kept for macOS and Linux.
//
// ⌘, for Settings and ⌘/ for a shortcuts cheat sheet are what every other app on
// these platforms uses, and AppKit and GTK both render punctuation keys as the
// character rather than as a virtual-key name. Windows does not, which is the
// whole reason menu_keys_windows.go exists.
func settingsAccelerator() *keys.Accelerator {
	return keys.CmdOrCtrl(",")
}

func shortcutsAccelerator() *keys.Accelerator {
	return keys.CmdOrCtrl("/")
}
