//go:build darwin

package share

import (
	"fmt"
	"time"

	"golang.org/x/sys/unix"
)

// markQuarantine flags a received file the way a browser download is flagged,
// so Gatekeeper gives a .dmg, .pkg or .app that arrived from another machine
// the same scrutiny it would give one fetched from the web.
//
// Best effort by design: the file has already landed, and a missing xattr is
// not worth failing a completed transfer over. Errors are swallowed rather than
// logged because a filesystem that does not support xattrs (a network share, a
// FAT volume) would otherwise produce one line per file for no benefit.
//
// The value is the standard four-field form: flags, timestamp, the agent that
// fetched it, and an event UUID we have none of.
func markQuarantine(path string) {
	// 0083 = kLSQuarantineTypeOtherDownload, unopened.
	value := fmt.Sprintf("0083;%x;yv;", time.Now().Unix())
	_ = unix.Setxattr(path, "com.apple.quarantine", []byte(value), 0)
}
