package updater

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Installing on macOS: mount the DMG, copy the bundle out of it, swap it for the
// running one, and relaunch after this process has actually exited.
//
// Each of those four steps has a way of going wrong that is specific to macOS and
// not obvious from the outside; the comments below are about those rather than
// about what the code does.

const (
	// hdiutil and cp are bounded because a hung one would otherwise hold the
	// update — and with it the app, which is waiting on this — open forever.
	mountTimeout = 60 * time.Second
	copyTimeout  = 5 * time.Minute
)

// bundlePath returns the .app this process is running from, or "" if it is not
// running from a bundle at all (a bare `go build` binary, or `wails dev`).
func bundlePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	// …/yv.app/Contents/MacOS/yv — three levels up from the executable.
	macOS := filepath.Dir(exe)
	contents := filepath.Dir(macOS)
	app := filepath.Dir(contents)
	if filepath.Base(macOS) != "MacOS" || filepath.Base(contents) != "Contents" ||
		!strings.HasSuffix(app, ".app") {
		return ""
	}
	return app
}

// InstallCheck decides whether this copy is in a position to replace itself.
//
// Asked before downloading rather than after. All three refusals below are
// permanent for this launch — no amount of retrying changes them — so learning
// about one at the end of a 40 MB download wastes the download and reads as a
// failure rather than as a thing the user needs to do.
func (u *Updater) InstallCheck() InstallState {
	app := bundlePath()
	return classifyBundle(app, app != "" && writableDir(filepath.Dir(app)))
}

// classifyBundle is InstallCheck's decision, separated from the two things it
// cannot do in a test: find out where this process is running from, and find out
// whether that place is writable.
func classifyBundle(app string, writable bool) InstallState {
	if app == "" {
		return InstallState{Reason: "This build is not an app bundle, so it cannot replace itself."}
	}

	// Gatekeeper runs a quarantined app from a randomised read-only mount rather
	// than from where the user thinks it is. Writing there fails, and worse, the
	// path is not the one they would look at — so the message has to name the
	// fix rather than the symptom.
	if strings.Contains(app, "/AppTranslocation/") {
		return InstallState{Reason: "yv is running from a read-only copy macOS made. Move yv into Applications and open it from there."}
	}

	// Running straight out of the downloaded disk image. Replacing the bundle
	// would write to the image, and quitting would take the app with it.
	if strings.HasPrefix(app, "/Volumes/") {
		return InstallState{Reason: "yv is running from a disk image. Drag yv into Applications and open it from there."}
	}

	if !writable {
		return InstallState{Reason: fmt.Sprintf("yv cannot write to %s, so it cannot replace itself there.", filepath.Dir(app))}
	}

	return InstallState{CanSelfUpdate: true}
}

// Apply replaces the running bundle with the one inside the downloaded DMG.
func (u *Updater) Apply(ctx context.Context, dmgPath string) error {
	if state := u.InstallCheck(); !state.CanSelfUpdate {
		return fmt.Errorf("%s", state.Reason)
	}
	current := bundlePath()

	mount, detach, err := mountDMG(ctx, dmgPath)
	if err != nil {
		return err
	}
	defer detach()

	source, err := findBundle(mount)
	if err != nil {
		return err
	}

	// Staged beside the app rather than in the update directory so the final
	// move is a rename within one filesystem — atomic, and instant even for a
	// bundle of hundreds of megabytes. A cross-device rename would silently
	// become a copy, which is neither.
	staging := filepath.Join(filepath.Dir(current), stagingName)
	_ = os.RemoveAll(staging)
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return fmt.Errorf("could not prepare a staging directory: %w", err)
	}
	defer os.RemoveAll(staging)

	staged := filepath.Join(staging, filepath.Base(source))
	// `cp -R` rather than a Go tree walk: a bundle carries symlinks (every
	// framework has Versions/Current), extended attributes and resource forks,
	// and reimplementing that faithfully is a much larger surface than shelling
	// out to the tool that already does it.
	if err := run(ctx, copyTimeout, "cp", "-R", source, staged); err != nil {
		return fmt.Errorf("could not copy the new version out of the disk image: %w", err)
	}

	return swapBundle(current, staged)
}

// swapBundle replaces current with staged, falling back to an authenticated
// replace if the plain one is refused.
func swapBundle(current, staged string) error {
	// The old bundle is moved aside rather than deleted outright, so that a
	// failure at the rename below still has something to put back. Deleting
	// first and then failing leaves no yv at all.
	backup := current + ".old"
	_ = os.RemoveAll(backup)

	if err := os.Rename(current, backup); err != nil {
		return elevatedReplace(current, staged)
	}
	if err := os.Rename(staged, current); err != nil {
		// Put it back. This is the one path where failing quietly would leave
		// the user with no application at all.
		if restoreErr := os.Rename(backup, current); restoreErr != nil {
			return fmt.Errorf("the update failed and the old version could not be restored (it is at %s): %w", backup, err)
		}
		return fmt.Errorf("could not install the new version: %w", err)
	}

	// Removing the old bundle is the only step allowed to fail silently: the new
	// one is already in place and working, and SweepStale clears the leftover on
	// the next launch.
	_ = os.RemoveAll(backup)
	return nil
}

// elevatedReplace asks for an administrator password and does the swap as root.
//
// Reached when the app lives somewhere this user cannot write — /Applications on
// a managed machine, typically. The alternative is refusing the update outright,
// which for the one case where a password genuinely is required is worse than
// asking for it.
func elevatedReplace(current, staged string) error {
	script := fmt.Sprintf(
		`do shell script "rm -rf " & quoted form of %s & " && mv " & quoted form of %s & " " & quoted form of %s & " && chown -R $(id -u):$(id -g) " & quoted form of %s with administrator privileges`,
		asString(current), asString(staged), asString(current), asString(current),
	)
	if err := run(context.Background(), copyTimeout, "osascript", "-e", script); err != nil {
		return fmt.Errorf("could not replace %s, even with an administrator password: %w", current, err)
	}
	return nil
}

// asString renders a path as an AppleScript string literal.
//
// Two layers of quoting are in play and both matter: this one stops a path
// containing a quote or a backslash from ending the literal and being read as
// script, and `quoted form of` in the script above stops the same path from
// being re-split by the shell that `do shell script` starts. Getting either
// wrong turns a filename into code running as root.
func asString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		if r == '"' || r == '\\' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('"')
	return b.String()
}

// ── the disk image ──────────────────────────────────────────────────────

// mountDMG attaches the image and returns its mount point plus a detach func.
func mountDMG(ctx context.Context, dmgPath string) (string, func(), error) {
	dir, err := UpdateDir()
	if err != nil {
		return "", nil, err
	}

	// An explicit mount point, because the default is derived from the volume
	// name — and if a volume called "yv" is already mounted (the user opened the
	// DMG themselves, which is exactly how they installed it), macOS quietly
	// mounts this one at "/Volumes/yv 1" and the bundle is copied from whichever
	// one the guess happened to name.
	explicit := filepath.Join(dir, "mnt")
	_ = os.RemoveAll(explicit)
	if err := os.MkdirAll(explicit, 0o755); err != nil {
		return "", nil, fmt.Errorf("could not prepare a mount point: %w", err)
	}

	args := []string{"attach", "-plist", "-nobrowse", "-noverify", "-noautoopen", "-readonly"}
	out, err := output(ctx, mountTimeout, "hdiutil", append(args, "-mountpoint", explicit, dmgPath)...)
	if err == nil {
		return explicit, func() { detach(explicit) }, nil
	}

	// -mountpoint is refused for some image layouts (a multi-partition image, or
	// one with a licence agreement). Falling back to the default location means
	// parsing where it actually went.
	_ = os.RemoveAll(explicit)
	out, err = output(ctx, mountTimeout, "hdiutil", append(args, dmgPath)...)
	if err != nil {
		return "", nil, fmt.Errorf("could not open the downloaded disk image: %w", err)
	}

	mount := parseAttachOutput(out)
	if mount == "" {
		return "", nil, fmt.Errorf("the downloaded disk image mounted, but nowhere findable")
	}
	return mount, func() { detach(mount) }, nil
}

func detach(mount string) {
	ctx, cancel := context.WithTimeout(context.Background(), mountTimeout)
	defer cancel()
	if err := run(ctx, mountTimeout, "hdiutil", "detach", mount, "-quiet"); err != nil {
		// Busy is the normal reason, and it resolves itself; force is a second
		// attempt rather than the first, so a genuinely in-use volume is not
		// yanked from under something else.
		_ = run(ctx, mountTimeout, "hdiutil", "detach", mount, "-force", "-quiet")
	}
}

// parseAttachOutput finds the mount point in `hdiutil attach -plist` output.
func parseAttachOutput(out []byte) string {
	// The plist is converted by plutil rather than parsed here, to avoid a plist
	// library for one field.
	cmd := exec.Command("plutil", "-convert", "json", "-o", "-", "-")
	cmd.Stdin = bytes.NewReader(out)
	if jsonOut, err := cmd.Output(); err == nil {
		var parsed struct {
			SystemEntities []struct {
				MountPoint string `json:"mount-point"`
			} `json:"system-entities"`
		}
		if json.Unmarshal(jsonOut, &parsed) == nil {
			for _, e := range parsed.SystemEntities {
				if e.MountPoint != "" {
					return e.MountPoint
				}
			}
		}
	}

	// Fallback for plain (non-plist) output, which is what hdiutil prints if the
	// -plist flag was among the ones it rejected.
	//
	// Split on tabs, not on whitespace: the columns are tab-separated and a mount
	// point may contain spaces, so splitting on spaces truncates "/Volumes/yv 1"
	// to "/Volumes/yv" — a path that may well exist and be something else.
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Split(line, "\t")
		last := strings.TrimSpace(fields[len(fields)-1])
		if strings.HasPrefix(last, "/Volumes/") {
			return last
		}
	}
	return ""
}

// findBundle locates the single .app at the root of a mounted image.
func findBundle(mount string) (string, error) {
	entries, err := os.ReadDir(mount)
	if err != nil {
		return "", fmt.Errorf("could not read the disk image: %w", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".app") {
			return filepath.Join(mount, e.Name()), nil
		}
	}
	return "", fmt.Errorf("the downloaded disk image contains no application")
}

// ── relaunch ────────────────────────────────────────────────────────────

// Relaunch starts the new copy and exits this one.
//
// The wait is the whole trick. `open` on a bundle whose process is still running
// activates the existing instance instead of starting a new one, so opening
// before exiting would just bring the *old* app to the front and then quit it —
// leaving nothing running and looking exactly like a crash. So a detached shell
// polls until this process is gone, and only then opens.
func (u *Updater) Relaunch() error {
	app := bundlePath()
	if app == "" {
		return ErrNotSupported
	}

	script := fmt.Sprintf(
		`while kill -0 %d 2>/dev/null; do sleep 0.2; done; exec open %s`,
		os.Getpid(), shQuote(app),
	)

	cmd := exec.Command("/bin/sh", "-c", script)
	// Its own process group, so it survives anything sent to ours on the way
	// out — otherwise the thing waiting for us to die dies with us.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not schedule the restart: %w", err)
	}
	// Released rather than waited on: this process is about to exit, and the
	// child has to outlive it.
	_ = cmd.Process.Release()
	return nil
}

// shQuote wraps a string in single quotes for /bin/sh, which makes every
// character literal except the quote itself.
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// ── cleanup ─────────────────────────────────────────────────────────────

// SweepStale clears what a previous update may have left behind: a mounted image
// from a run that was killed mid-install, a staging directory, and the .old
// bundle kept as a fallback during the swap.
//
// Every path is checked against a directory we own before anything is detached
// or deleted. A user who has their own disk image mounted, or their own folder
// that happens to be named like ours, is not part of this.
func (u *Updater) SweepStale() {
	dir, err := UpdateDir()
	if err != nil {
		return
	}

	if mount := filepath.Join(dir, "mnt"); isWithin(dir, mount) {
		if entries, err := os.ReadDir(mount); err == nil && len(entries) > 0 {
			detach(mount)
		}
		_ = os.RemoveAll(mount)
	}

	if app := bundlePath(); app != "" {
		appDir := filepath.Dir(app)
		for _, leftover := range []string{
			filepath.Join(appDir, stagingName),
			app + ".old",
		} {
			if isWithin(appDir, leftover) {
				_ = os.RemoveAll(leftover)
			}
		}
	}
}

// ── running commands ────────────────────────────────────────────────────

func run(ctx context.Context, timeout time.Duration, name string, args ...string) error {
	_, err := output(ctx, timeout, name, args...)
	return err
}

func output(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		// stderr carries the actual reason (hdiutil's "resource temporarily
		// unavailable", cp's "Permission denied"); the exit status alone says
		// only that something went wrong.
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return stdout.Bytes(), fmt.Errorf("%s: %s", name, msg)
		}
		return stdout.Bytes(), fmt.Errorf("%s: %w", name, err)
	}
	return stdout.Bytes(), nil
}
