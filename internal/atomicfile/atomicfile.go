// Package atomicfile writes a file so that a reader never observes a partial
// one.
//
// os.WriteFile truncates the target and then writes into it. A crash, a full
// disk, or a kill between those two steps leaves a truncated file — which for
// projects.json means every project the user has ever created is gone. That is
// not a hypothetical: the window is small but it is hit by exactly the events
// during which people most want their data back.
//
// Write instead builds the new contents beside the target and renames over it.
// Rename within a directory is atomic on every filesystem this app runs on, so
// a reader sees either the old file or the new one, never a half-written mix.
package atomicfile

import (
	"fmt"
	"os"
	"path/filepath"
)

// Write atomically replaces path with data.
//
// The temporary file is created in the target's own directory, not in TMPDIR:
// os.Rename across filesystems fails outright on Linux and silently degrades to
// a non-atomic copy elsewhere, and /tmp is very often a different filesystem.
//
// The contents are fsync'd before the rename, so a crash immediately after
// cannot leave the rename durable while the bytes it points at are not — a
// rename that lands on an empty file is worse than no write at all.
func Write(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)

	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("create temp in %s: %w", dir, err)
	}
	name := tmp.Name()

	// Removing a name that has already been renamed away is a no-op, so this is
	// safe on the success path and is the only cleanup on every failure path.
	defer os.Remove(name)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp: %w", err)
	}

	// CreateTemp always makes the file 0600. Callers that want a group- or
	// world-readable file must have that applied before it becomes visible,
	// or the permissions would briefly differ from what they asked for.
	if err := os.Chmod(name, perm); err != nil {
		return fmt.Errorf("chmod temp: %w", err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("rename into place: %w", err)
	}
	return nil
}
