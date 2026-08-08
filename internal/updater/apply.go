package updater

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Installing an update is the one part of this that cannot be shared across
// platforms, because the obstacle is different on each: macOS has to get a
// bundle off a disk image and past Gatekeeper's read-only copy, Windows cannot
// delete a running executable, and Linux depends entirely on how the thing was
// installed. Each apply_*.go supplies these three; everything above them is
// common.

// InstallState says whether this copy can replace itself, and if not, why.
//
// The reason is user-facing text rather than a code. There is exactly one thing
// the UI does with a false — offer the release page instead of a download — and
// the only useful difference between the cases is what it tells the person, so
// carrying an enum to switch on would be a layer that only ever gets formatted
// back into a sentence.
type InstallState struct {
	CanSelfUpdate bool   `json:"canSelfUpdate"`
	Reason        string `json:"reason,omitempty"`
}

// ErrNotSupported is the answer on a platform with no apply implementation.
var ErrNotSupported = errors.New("this build cannot install its own updates")

// stagingName is the directory an update is assembled in before it replaces the
// running copy. Dot-prefixed so it does not show up in Finder or a file listing
// during the second it exists.
const stagingName = ".yv-update-staging"

// isWithin reports whether path is inside root.
//
// Used to scope every destructive sweep. The macOS one detaches disk images and
// the Windows one deletes backup directories, and both must be able to say "this
// is ours" about a path before touching it — a user's own mounted DMG happening
// to be called yv is not ours.
func isWithin(root, path string) bool {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	pathAbs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(rootAbs, pathAbs)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// writableDir reports whether we can create files in dir, by trying.
//
// Checking the mode bits instead would be a guess: it ignores ACLs, read-only
// mounts, SIP and the difference between the file's owner and this process. The
// question is only ever "can we write here", so the honest test is to write.
func writableDir(dir string) bool {
	f, err := os.CreateTemp(dir, ".yv-write-check-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}
