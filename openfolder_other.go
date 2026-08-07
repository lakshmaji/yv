//go:build !darwin && !linux

package main

import "fmt"

// openFolder is unavailable on platforms this app does not ship an opener for.
//
// The caller reports the failure and leaves the path on screen, which is the
// same outcome as a file manager that refuses to start — the user can still get
// to their files, just by hand.
func openFolder(string) error {
	return fmt.Errorf("opening a folder is not supported on this platform")
}
