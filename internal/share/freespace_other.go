//go:build !darwin && !linux

package share

// FreeSpace reports that the figure is unavailable on platforms this app does
// not ship a syscall for.
//
// The caller treats "unknown" as "allow": refusing a transfer because we could
// not measure the disk would block something that would very likely have
// worked, and the write itself still fails safely if it really does not fit.
func FreeSpace(string) (int64, bool) { return 0, false }
