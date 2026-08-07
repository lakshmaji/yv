//go:build darwin

package main

import "os/exec"

// openFolder reveals a directory in Finder.
//
// `open` rather than the Wails runtime's BrowserOpenURL: that validates the
// scheme and rejects anything that is not http(s), so a file:// URL is refused
// outright on some platforms. Handing the path to the OS opener is what every
// desktop app does here, and it needs no URL escaping — the path is passed as
// an argument, never through a shell, so spaces and quotes in a home directory
// are not special.
func openFolder(dir string) error {
	cmd := exec.Command("open", dir)
	if err := cmd.Start(); err != nil {
		return err
	}
	// Reaped in the background: Finder outlives the call, and leaving the child
	// unwaited would keep a zombie for the life of the app.
	go func() { _ = cmd.Wait() }()
	return nil
}
