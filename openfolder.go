package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// openerTimeout is how long an opener is given to report a problem.
//
// The openers this app uses hand off to the desktop and return promptly —
// `open` to LaunchServices, `xdg-open` to the session's handler — so a command
// still running after this has almost certainly succeeded and is simply waiting
// on something we do not care about. Treating that as success is deliberate:
// the alternative is blocking the caller on a file manager's lifetime.
const openerTimeout = 5 * time.Second

// runOpener launches a desktop opener and reports whether it actually worked.
//
// Waiting for the exit status is the point. Checking only that the process
// started proves the binary exists and nothing more — `open` returns non-zero
// for a path it cannot handle, and reporting success there is how a button ends
// up doing nothing with no explanation, which is exactly what happened.
//
// Arguments are passed as a slice, never through a shell, so spaces and quotes
// in a home directory are not special.
func runOpener(argv ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), openerTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err == nil {
		return nil
	}
	// Still running when the timeout struck: it launched, and whatever it is
	// waiting for is not ours to wait for too.
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil
	}

	if msg := strings.TrimSpace(stderr.String()); msg != "" {
		return fmt.Errorf("%s: %s", argv[0], msg)
	}
	return fmt.Errorf("%s: %w", argv[0], err)
}
