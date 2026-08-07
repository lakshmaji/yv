//go:build !windows

package runner

import "syscall"

// A command runs under a PTY with Setsid, so its pid is also its process-group
// id. Signalling -pid therefore reaches the shell *and* everything it spawned —
// killing only the shell would leave a dev server or an emulator running with
// nothing left to stop it.

// terminateGroup asks the group to shut down cleanly.
func terminateGroup(pid int) error { return syscall.Kill(-pid, syscall.SIGTERM) }

// killGroup takes the group down without giving it a say.
func killGroup(pid int) error { return syscall.Kill(-pid, syscall.SIGKILL) }
