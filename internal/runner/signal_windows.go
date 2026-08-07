//go:build windows

package runner

import (
	"os/exec"
	"strconv"
)

// Windows has neither POSIX process groups nor signals, so both stops go through
// taskkill: /T walks the child tree the way signalling -pgid does on Unix, and
// /F is the only kill it offers. There is no polite variant to try first, which
// means terminateGroup and killGroup do the same thing here — the caller's
// three-second SIGTERM-then-SIGKILL escalation is simply a no-op on the second
// pass, since nothing survives the first.

func terminateGroup(pid int) error { return taskkill(pid) }

func killGroup(pid int) error { return taskkill(pid) }

func taskkill(pid int) error {
	return exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid)).Run()
}
