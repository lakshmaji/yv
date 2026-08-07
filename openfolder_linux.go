//go:build linux

package main

import (
	"fmt"
	"os/exec"
)

// openFolder opens a directory in the desktop's file manager.
//
// The Wails runtime's BrowserOpenURL cannot do this on Linux: it validates the
// scheme and refuses anything that is not http(s), so a file:// URL comes back
// as "invalid schema not allowed". The opener has to be invoked directly.
//
// xdg-open is the freedesktop standard and is what a correctly configured
// desktop answers with. gio is the fallback because a minimal install can
// easily lack xdg-utils while still having GLib — which is guaranteed here
// anyway, since the app itself is GTK.
//
// The path is passed as an argument rather than interpolated into a shell, so
// spaces and quotes in a home directory are not special.
func openFolder(dir string) error {
	candidates := [][]string{
		{"xdg-open", dir},
		{"gio", "open", dir},
		{"nautilus", dir},
	}

	var first error
	for _, argv := range candidates {
		cmd := exec.Command(argv[0], argv[1:]...)
		if err := cmd.Start(); err != nil {
			if first == nil {
				first = err
			}
			continue
		}
		// Reaped in the background: the file manager outlives this call, and
		// leaving the child unwaited would keep a zombie for the life of the app.
		go func() { _ = cmd.Wait() }()
		return nil
	}

	if first == nil {
		first = fmt.Errorf("no file manager found")
	}
	return fmt.Errorf("could not open a file manager (tried xdg-open, gio, nautilus): %w", first)
}
