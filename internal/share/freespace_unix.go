//go:build darwin || linux

package share

import (
	"os"
	"path/filepath"
	"syscall"
)

// FreeSpace reports the bytes available to this user under dir, and whether the
// figure could be obtained at all.
//
// dir may not exist yet — the receive folder is created on first use — so the
// walk goes up to the nearest existing ancestor. Statfs answers per filesystem,
// and the parent is on the same one.
//
// Bavail rather than Bfree: the latter counts blocks reserved for root, which
// this app cannot write to.
func FreeSpace(dir string) (int64, bool) {
	path := dir
	for {
		if _, err := os.Stat(path); err == nil {
			break
		}
		parent := filepath.Dir(path)
		if parent == path {
			return 0, false
		}
		path = parent
	}

	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, false
	}
	// Both fields are integers on darwin and linux but not the same width, so
	// the conversion is what makes this one file rather than two.
	return int64(uint64(st.Bavail) * uint64(st.Bsize)), true
}
