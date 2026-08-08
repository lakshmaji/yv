package updater

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

// On Linux the question is not how to replace the binary — it is which of three
// installs this is.
//
//   - AppImage: one file the user owns, sitting wherever they put it. Replacing
//     it is a rename, and no password is involved.
//   - .deb: /usr/bin/yv, owned by root. Overwriting it needs a graphical sudo
//     prompt on every update, and does it behind dpkg's back, so apt goes on
//     believing the old version is installed. Both are worse than not doing it.
//   - tarball: a loose binary anywhere. Nothing identifies it as ours to update.
//
// Only the first can self-update, and the other two are told plainly rather than
// being offered a download that would fail.

// appImagePath returns the AppImage this process is running from, or "".
//
// The AppImage runtime exports APPIMAGE with the absolute path of the image
// itself — as opposed to APPDIR, which is the temporary mount the payload runs
// from, and which is useless here because it disappears on exit.
//
// Its presence is the entire test. Nothing else distinguishes an AppImage
// install from a tarball: the payload sees an ordinary filesystem either way.
func appImagePath() string {
	path := os.Getenv("APPIMAGE")
	if path == "" {
		return ""
	}
	if !filepath.IsAbs(path) {
		return ""
	}
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		return ""
	}
	return path
}

func (u *Updater) InstallCheck() InstallState {
	return classifyLinuxInstall(appImagePath(), writableDir)
}

// classifyLinuxInstall is the decision, with the filesystem passed in so a test
// can exercise every branch.
func classifyLinuxInstall(appImage string, writable func(string) bool) InstallState {
	if appImage == "" {
		return InstallState{
			Reason: "This copy of yv was installed from a package, so updates go through your package manager. " +
				"The AppImage build updates itself.",
		}
	}
	// The replacement is written next to the current image before being renamed
	// over it, so the directory has to be writable — an AppImage dropped in
	// /opt by an administrator is not ours to replace.
	dir := filepath.Dir(appImage)
	if !writable(dir) {
		return InstallState{
			Reason: fmt.Sprintf("yv cannot write to %s, so it cannot replace itself there. Move the AppImage somewhere your account owns.", dir),
		}
	}
	return InstallState{CanSelfUpdate: true}
}

// Apply replaces the running AppImage with the downloaded one.
func (u *Updater) Apply(_ context.Context, artifact string) error {
	if state := u.InstallCheck(); !state.CanSelfUpdate {
		return fmt.Errorf("%s", state.Reason)
	}
	return replaceAppImage(appImagePath(), artifact)
}

func replaceAppImage(current, artifact string) error {
	// Staged in the same directory so the rename below is within one
	// filesystem. The update directory is under $XDG_CONFIG_HOME, which on a
	// machine with a separate /home is a different device — and a cross-device
	// rename fails rather than silently copying.
	staged := current + ".new"
	_ = os.Remove(staged)

	if err := copyInto(artifact, staged); err != nil {
		_ = os.Remove(staged)
		return err
	}
	// Before the rename: an AppImage that is not executable is not an
	// application, and doing it after would leave a window in which the
	// installed file cannot be launched.
	if err := os.Chmod(staged, 0o755); err != nil {
		_ = os.Remove(staged)
		return fmt.Errorf("could not make the new version executable: %w", err)
	}

	// Atomic. The file is either wholly the old version or wholly the new one,
	// so a machine that loses power here still has a working yv. Renaming over
	// a running AppImage is fine on Linux: the kernel holds the old inode open
	// for as long as this process needs it.
	if err := os.Rename(staged, current); err != nil {
		_ = os.Remove(staged)
		return fmt.Errorf("could not install the new version: %w", err)
	}
	return nil
}

func copyInto(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("could not read the download: %w", err)
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return fmt.Errorf("could not write beside the current version: %w", err)
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return fmt.Errorf("could not write the new version: %w", err)
	}
	// Without this the rename can be durable while the contents are not, which
	// on an unclean shutdown leaves a correctly-named file of zeros where the
	// application used to be.
	if err := out.Sync(); err != nil {
		return fmt.Errorf("could not flush the new version: %w", err)
	}
	return nil
}

// Relaunch replaces this process with the new AppImage.
//
// Exec rather than spawn-and-exit: the process keeps its PID, its terminal and
// its place in whatever started it, so a yv launched from a shell or a desktop
// file does not leave a confused parent behind. There is none of the
// wait-for-exit trouble macOS has — nothing here refuses to start a second copy,
// and after an exec there is no second copy anyway.
func (u *Updater) Relaunch() error {
	path := appImagePath()
	if path == "" {
		return ErrNotSupported
	}
	// Only returns on failure.
	return syscall.Exec(path, append([]string{path}, os.Args[1:]...), os.Environ())
}

// SweepStale removes a partial replacement left by a run that died between the
// copy and the rename.
func (u *Updater) SweepStale() {
	if path := appImagePath(); path != "" {
		dir := filepath.Dir(path)
		if leftover := path + ".new"; isWithin(dir, leftover) {
			_ = os.Remove(leftover)
		}
	}
	if updates, err := UpdateDir(); err == nil {
		staged := filepath.Join(updates, "staged")
		if isWithin(updates, staged) {
			_ = os.RemoveAll(staged)
		}
	}
}
