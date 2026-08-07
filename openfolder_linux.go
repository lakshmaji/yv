//go:build linux

package main

import (
	"fmt"
	"strings"
)

// openFolder opens a directory in the desktop's file manager.
//
// The Wails runtime's BrowserOpenURL cannot do this on Linux: it validates the
// scheme and refuses anything that is not http(s), so a file:// URL comes back
// as "invalid schema not allowed". The opener has to be invoked directly.
//
// xdg-open is the freedesktop standard and is what a correctly configured
// desktop answers with. gio is the fallback because a minimal install can
// easily lack xdg-utils while still having GLib — which is present here
// regardless, since the app itself is GTK. nautilus is the last resort.
//
// A candidate that exits non-zero is treated as a failure and the next is
// tried, not just one that is missing: xdg-open is frequently installed but
// misconfigured, and that returns an error rather than refusing to start.
func openFolder(dir string) error {
	candidates := [][]string{
		{"xdg-open", dir},
		{"gio", "open", dir},
		{"nautilus", dir},
	}

	var failures []string
	for _, argv := range candidates {
		if err := runOpener(argv...); err == nil {
			return nil
		} else {
			failures = append(failures, err.Error())
		}
	}
	return fmt.Errorf("could not open a file manager — %s", strings.Join(failures, "; "))
}
