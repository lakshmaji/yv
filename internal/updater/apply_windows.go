package updater

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// Installing on Windows is one problem: the running .exe cannot be deleted or
// overwritten. It *can* be renamed, and that is the whole basis of what follows —
// move it out of the way, put the new one where it was, and clear the leftover on
// the next launch.
//
// The unpacking and file-swapping this uses lives in archive.go, which has no
// build tag so that its zip-slip guard can be exercised on the machine this is
// developed on rather than only on the machine it ships to.

// backupName holds files displaced during the copy, so a failure part way
// through can put them all back.
const backupName = ".yv-backup"

func (u *Updater) InstallCheck() InstallState {
	exe, err := os.Executable()
	if err != nil {
		return InstallState{Reason: "yv cannot locate its own executable, so it cannot replace it."}
	}
	dir := filepath.Dir(exe)
	if !writableDir(dir) {
		return InstallState{Reason: fmt.Sprintf(
			"yv cannot write to %s, so it cannot replace itself there. "+
				"Reinstall it somewhere your account owns, or update by hand.", dir)}
	}
	return InstallState{CanSelfUpdate: true}
}

// Apply unpacks the downloaded zip over the installation directory.
func (u *Updater) Apply(ctx context.Context, zipPath string) error {
	if state := u.InstallCheck(); !state.CanSelfUpdate {
		return fmt.Errorf("%s", state.Reason)
	}

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exeDir := filepath.Dir(exe)

	updates, err := UpdateDir()
	if err != nil {
		return err
	}
	staged := filepath.Join(updates, "staged")
	_ = os.RemoveAll(staged)
	defer os.RemoveAll(staged)

	// Unpacked fully before anything is touched, so an archive that turns out to
	// be truncated or hostile is discovered while the install is still intact.
	if err := extractZip(ctx, zipPath, staged); err != nil {
		return err
	}

	// Renaming the running executable is permitted where deleting it is not, and
	// it has to happen before anything is copied over it. The leftover cannot be
	// removed now — it is still the image this process is executing — so
	// SweepStale clears it on the next launch.
	old := exe + ".old"
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return fmt.Errorf("could not move the running executable aside: %w", err)
	}

	backup := filepath.Join(exeDir, backupName)
	_ = os.RemoveAll(backup)

	if err := copyTree(staged, exeDir, backup); err != nil {
		// Unwound in reverse: the displaced files first, then the executable, so
		// a half-copied install is never what the user is left with.
		restoreBackup(backup, exeDir)
		if renameErr := os.Rename(old, exe); renameErr != nil {
			return fmt.Errorf("the update failed and yv.exe could not be restored (it is at %s): %w", old, err)
		}
		return err
	}

	_ = os.RemoveAll(backup)
	return nil
}

// Relaunch starts the replacement and lets this process exit.
//
// None of the wait-for-exit dance macOS needs: Windows starts a second instance
// happily, and after the swap the new executable is a different file from the one
// this process is running out of anyway.
func (u *Updater) Relaunch() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe)
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not restart yv: %w", err)
	}
	// Released rather than waited on — this process is about to exit.
	return cmd.Process.Release()
}

// SweepStale removes what the last update could not remove while it was running:
// the renamed old executable, and any backup a failure left behind.
func (u *Updater) SweepStale() {
	if updates, err := UpdateDir(); err == nil {
		staged := filepath.Join(updates, "staged")
		if isWithin(updates, staged) {
			_ = os.RemoveAll(staged)
		}
	}

	exe, err := os.Executable()
	if err != nil {
		return
	}
	exeDir := filepath.Dir(exe)
	for _, leftover := range []string{exe + ".old", filepath.Join(exeDir, backupName)} {
		if isWithin(exeDir, leftover) {
			_ = os.RemoveAll(leftover)
		}
	}
}
