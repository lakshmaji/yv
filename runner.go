package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/creack/pty"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// runShellCommandCtx runs one shell command synchronously, streaming output via emit.
// It uses a PTY so the child process sees a terminal and stays line-buffered.
// Cancelling ctx sends SIGTERM to the process (used for post-hook timeouts).
func (a *App) runShellCommandCtx(ctx context.Context, cmdID, shellCmd, workDir string, emit func(string)) (int, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "zsh"
	}
	// -l (login) sources /etc/zprofile + ~/.zprofile so Homebrew PATH is available.
	c := exec.Command(shell, "-l", "-c", shellCmd)
	c.Dir = workDir

	ptmx, err := pty.Start(c)
	if err != nil {
		return -1, fmt.Errorf("pty start: %w", err)
	}
	defer ptmx.Close()

	a.ptmxMu.Lock()
	a.ptmxWriters[cmdID] = ptmx
	a.ptmxMu.Unlock()
	defer func() {
		a.ptmxMu.Lock()
		delete(a.ptmxWriters, cmdID)
		a.ptmxMu.Unlock()
	}()

	a.processesMu.Lock()
	a.processes[cmdID] = c
	a.processesMu.Unlock()

	// Kill process when ctx is cancelled (timeout or main-command failure).
	killerCtx, stopKiller := context.WithCancel(context.Background())
	defer stopKiller()
	go func() {
		select {
		case <-ctx.Done():
			pgid := c.Process.Pid
			_ = syscall.Kill(-pgid, syscall.SIGTERM)
		case <-killerCtx.Done():
		}
	}()

	// PTY merges stdout+stderr; read raw bytes so prompts without a trailing
	// newline (e.g. "[y/N] ") are emitted immediately instead of blocking.
	buf := make([]byte, 32*1024)
	for {
		n, readErr := ptmx.Read(buf)
		if n > 0 {
			text := strings.ReplaceAll(string(buf[:n]), "\r", "")
			text = ansiRe.ReplaceAllString(text, "")
			parts := strings.Split(text, "\n")
			for i, part := range parts {
				if i < len(parts)-1 {
					emit(part) // complete line
				} else if part != "" {
					emit(part) // partial line / prompt (no trailing \n)
				}
			}
		}
		if readErr != nil {
			break
		}
	}
	stopKiller() // process exited naturally; stop killer goroutine

	err = c.Wait()

	a.processesMu.Lock()
	delete(a.processes, cmdID)
	a.processesMu.Unlock()

	if ctx.Err() != nil {
		return -1, fmt.Errorf("timed out or cancelled")
	}
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode(), nil
		}
		return -1, err
	}
	return 0, nil
}

func (a *App) runShellCommand(cmdID, shellCmd, workDir string, emit func(string)) (int, error) {
	return a.runShellCommandCtx(context.Background(), cmdID, shellCmd, workDir, emit)
}

// ExecuteCommand starts a command (after running any pre-hooks) and streams stdout+stderr as Wails events.
// runID scopes all events to this specific invocation so stale events from a prior run can never
// clear the Stop button while a new run is still active.
// Events emitted:
//
//	"output:<cmdID>:<runID>"    string        — one line of output
//	"done:<cmdID>:<runID>"      CommandResult — main process exit info
//	"post-done:<cmdID>:<runID>" CommandResult — post-hooks exit info (only if PostCommands set)
func (a *App) ExecuteCommand(cmd CommandConfig, workingDir string, runID string) string {
	a.ctxMu.RLock()
	ctx := a.ctx
	a.ctxMu.RUnlock()

	// Kill any prior run of this command
	a.processesMu.Lock()
	if prior, ok := a.processes[cmd.ID]; ok {
		_ = prior.Process.Signal(syscall.SIGTERM)
		delete(a.processes, cmd.ID)
	}
	a.processesMu.Unlock()

	workDir := cmd.WorkingDir
	if workDir == "" {
		workDir = workingDir
	}

	outEvent      := "output:" + cmd.ID + ":" + runID
	doneEvent     := "done:" + cmd.ID + ":" + runID
	postDoneEvent := "post-done:" + cmd.ID + ":" + runID

	emit := func(line string) {
		if ctx != nil {
			wailsRuntime.EventsEmit(ctx, outEvent, line)
		}
	}

	go func() {
		if len(cmd.PostCommands) == 0 {
			// Original behaviour: pre-hooks + main command in one PTY session so that
			// environment changes in pre-hooks (eval, export, source, direnv) carry
			// into the main command.
			var script strings.Builder
			script.WriteString("set -e\n")
			for i, preCmd := range cmd.PreCommands {
				escaped := strings.ReplaceAll(preCmd, "'", `'\''`)
				fmt.Fprintf(&script, "echo '[PRE] %d/%d: %s'\n", i+1, len(cmd.PreCommands), escaped)
				script.WriteString(preCmd + "\n")
				script.WriteString("wait\n")
			}
			script.WriteString(cmd.Command + "\n")

			exitCode, err := a.runShellCommand(cmd.ID, script.String(), workDir, emit)
			result := CommandResult{}
			if err != nil {
				result.ExitCode = -1
				result.Error = err.Error()
			} else {
				result.ExitCode = exitCode
			}
			if ctx != nil {
				wailsRuntime.EventsEmit(ctx, doneEvent, result)
			}
			return
		}

		// Has post-hooks: pre-hooks run first (separately), then main starts non-blocking,
		// then post-hooks run concurrently with main (with per-hook timeout).
		// Post-hooks are cancelled automatically if main exits with an error.

		// 1. Pre-hooks (if any) — separate PTY session
		if len(cmd.PreCommands) > 0 {
			var preScript strings.Builder
			preScript.WriteString("set -e\n")
			for i, preCmd := range cmd.PreCommands {
				escaped := strings.ReplaceAll(preCmd, "'", `'\''`)
				fmt.Fprintf(&preScript, "echo '[PRE] %d/%d: %s'\n", i+1, len(cmd.PreCommands), escaped)
				preScript.WriteString(preCmd + "\n")
				preScript.WriteString("wait\n")
			}
			exitCode, err := a.runShellCommand(cmd.ID, preScript.String(), workDir, emit)
			if err != nil || exitCode != 0 {
				result := CommandResult{ExitCode: exitCode}
				if err != nil {
					result.ExitCode = -1
					result.Error = err.Error()
				}
				if ctx != nil {
					wailsRuntime.EventsEmit(ctx, doneEvent, result)
					wailsRuntime.EventsEmit(ctx, postDoneEvent, result)
				}
				return
			}
		}

		// 2. Start main command in a background goroutine (may run forever, e.g. emulator).
		mainFailed := make(chan struct{}, 1)
		go func() {
			exitCode, err := a.runShellCommand(cmd.ID, cmd.Command, workDir, emit)
			result := CommandResult{ExitCode: exitCode}
			if err != nil {
				result.ExitCode = -1
				result.Error = err.Error()
			}
			if result.ExitCode != 0 {
				select {
				case mainFailed <- struct{}{}:
				default:
				}
			}
			if ctx != nil {
				wailsRuntime.EventsEmit(ctx, doneEvent, result)
			}
		}()

		// 3. Cancel post-hooks when main fails/stops.
		postCtx, cancelPost := context.WithCancel(context.Background())
		defer cancelPost()
		go func() {
			select {
			case <-mainFailed:
				cancelPost()
			case <-postCtx.Done():
			}
		}()

		// 4. Run post-hooks sequentially with timeout.
		const defaultTimeoutSec = 120
		postExitCode := 0
		postErrStr := ""

		for i, postCmd := range cmd.PostCommands {
			if postCtx.Err() != nil {
				postExitCode = -1
				postErrStr = "main command failed or stopped"
				break
			}

			timeoutSec := postCmd.Timeout
			if timeoutSec <= 0 {
				timeoutSec = defaultTimeoutSec
			}

			emit(fmt.Sprintf("[POST] %d/%d: %s", i+1, len(cmd.PostCommands), postCmd.Command))

			tCtx, cancel := context.WithTimeout(postCtx, time.Duration(timeoutSec)*time.Second)
			exitCode, err := a.runShellCommandCtx(tCtx, cmd.ID+":post", postCmd.Command, workDir, emit)
			cancel()

			if postCtx.Err() != nil {
				postExitCode = -1
				postErrStr = "main command failed or stopped"
				break
			}
			if err != nil {
				postExitCode = -1
				postErrStr = err.Error()
				break
			}
			if exitCode != 0 {
				postExitCode = exitCode
				break
			}
		}

		if ctx != nil {
			result := CommandResult{ExitCode: postExitCode}
			if postErrStr != "" {
				result.Error = postErrStr
			}
			wailsRuntime.EventsEmit(ctx, postDoneEvent, result)
		}
	}()

	return "started"
}

// GetRunningCommands returns the IDs of all currently running command processes.
func (a *App) GetRunningCommands() []string {
	a.processesMu.RLock()
	defer a.processesMu.RUnlock()
	ids := make([]string, 0, len(a.processes))
	for id := range a.processes {
		if !strings.HasSuffix(id, ":post") {
			ids = append(ids, id)
		}
	}
	return ids
}

// SendInput writes text to the stdin of a running interactive command.
func (a *App) SendInput(cmdID string, text string) string {
	a.ptmxMu.RLock()
	ptmx, ok := a.ptmxWriters[cmdID]
	a.ptmxMu.RUnlock()
	if !ok {
		return "not running"
	}
	_, err := ptmx.Write([]byte(text))
	if err != nil {
		return "error: " + err.Error()
	}
	return "ok"
}

// StopCommand kills the process group (SIGTERM → SIGKILL after 3s).
// Using process group (-pgid) ensures child processes spawned by the shell are also terminated.
func (a *App) StopCommand(cmdID string) string {
	a.processesMu.RLock()
	c, ok := a.processes[cmdID]
	a.processesMu.RUnlock()

	if !ok {
		return "not running"
	}

	pgid := c.Process.Pid // PTY Setsid guarantees pgid == pid
	if err := syscall.Kill(-pgid, syscall.SIGTERM); err != nil {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		return "killed"
	}

	go func() {
		time.Sleep(3 * time.Second)
		a.processesMu.RLock()
		_, stillRunning := a.processes[cmdID]
		a.processesMu.RUnlock()
		if stillRunning {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
	}()

	return "stopping"
}
