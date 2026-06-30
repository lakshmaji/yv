package runner

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"yv/internal/models"
)

// ansiRe matches ANSI/VT escape sequences emitted by PTY-attached processes.
var ansiRe = regexp.MustCompile(`\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`)

// loginPath captures the user's full login-shell PATH exactly once at startup.
// We run "zsh -l -c 'echo $PATH'" silently (stderr discarded) so the brew
// shellenv warning never reaches any terminal row. The result gives every tool
// the user has — Homebrew, Android SDK, rbenv, nvm, etc. — without needing to
// hard-code individual tool directories.
var (
	loginPathOnce  sync.Once
	loginPathValue string
)

func resolveLoginPath() string {
	loginPathOnce.Do(func() {
		shell := os.Getenv("SHELL")
		if shell == "" {
			shell = "zsh"
		}
		// stderr goes to /dev/null so the brew CWD warning is never visible.
		cmd := exec.Command(shell, "-l", "-c", "echo $PATH")
		cmd.Stderr = nil
		if out, err := cmd.Output(); err == nil {
			loginPathValue = strings.TrimSpace(string(out))
		}
		if loginPathValue == "" {
			loginPathValue = os.Getenv("PATH")
		}
	})
	return loginPathValue
}

// ptmxBufPool reuses 32 KB read buffers across PTY sessions to reduce allocations.
var ptmxBufPool = sync.Pool{New: func() any { return make([]byte, 32*1024) }}

type Runner struct {
	processes   map[string]*exec.Cmd
	processesMu sync.RWMutex
	ptmxWriters map[string]*os.File
	ptmxMu      sync.RWMutex
	cmdLabels   map[string]string
	cmdLabelsMu sync.RWMutex
	wg          sync.WaitGroup // tracks live ExecuteCommand goroutines for clean shutdown
}

func NewRunner() *Runner {
	return &Runner{
		processes:   make(map[string]*exec.Cmd),
		ptmxWriters: make(map[string]*os.File),
		cmdLabels:   make(map[string]string),
	}
}

// GetProcessSnapshot returns a point-in-time copy of all non-post running processes
// with their labels. Used by the monitor without holding runner's internal locks.
func (r *Runner) GetProcessSnapshot() []models.ProcessEntry {
	r.processesMu.RLock()
	entries := make([]models.ProcessEntry, 0, len(r.processes))
	for id, cmd := range r.processes {
		if strings.HasSuffix(id, ":post") {
			continue
		}
		if cmd.Process != nil {
			entries = append(entries, models.ProcessEntry{PID: cmd.Process.Pid, CmdID: id, Label: id})
		}
	}
	r.processesMu.RUnlock()

	r.cmdLabelsMu.RLock()
	for i := range entries {
		if lbl, ok := r.cmdLabels[entries[i].CmdID]; ok {
			entries[i].Label = lbl
		}
	}
	r.cmdLabelsMu.RUnlock()

	return entries
}

// GetRunningCommands returns the IDs of all currently running command processes.
func (r *Runner) GetRunningCommands() []string {
	r.processesMu.RLock()
	defer r.processesMu.RUnlock()
	ids := make([]string, 0, len(r.processes))
	for id := range r.processes {
		if !strings.HasSuffix(id, ":post") {
			ids = append(ids, id)
		}
	}
	return ids
}

// SendInput writes text to the stdin of a running interactive command.
func (r *Runner) SendInput(cmdID string, text string) string {
	r.ptmxMu.RLock()
	ptmx, ok := r.ptmxWriters[cmdID]
	r.ptmxMu.RUnlock()
	if !ok {
		return "not running"
	}
	if _, err := ptmx.Write([]byte(text)); err != nil {
		return "error: " + err.Error()
	}
	return "ok"
}

// StopCommand kills the process group (SIGTERM → SIGKILL after 3s).
// Using process group (-pgid) ensures child processes spawned by the shell are also terminated.
func (r *Runner) StopCommand(cmdID string) string {
	r.processesMu.RLock()
	c, ok := r.processes[cmdID]
	r.processesMu.RUnlock()
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
		r.processesMu.RLock()
		_, stillRunning := r.processes[cmdID]
		r.processesMu.RUnlock()
		if stillRunning {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
	}()

	return "stopping"
}

// StopAll sends SIGTERM to all running processes, waits 3s, then SIGKILLs any survivors.
// It also waits for all ExecuteCommand goroutines to finish before returning.
func (r *Runner) StopAll() {
	type entry struct {
		id  string
		pid int
	}

	r.processesMu.RLock()
	snapshot := make([]entry, 0, len(r.processes))
	for id, cmd := range r.processes {
		if cmd.Process != nil {
			snapshot = append(snapshot, entry{id: id, pid: cmd.Process.Pid})
		}
	}
	r.processesMu.RUnlock()

	if len(snapshot) == 0 {
		r.wg.Wait()
		return
	}

	for _, e := range snapshot {
		_ = syscall.Kill(-e.pid, syscall.SIGTERM)
	}
	time.Sleep(3 * time.Second)

	r.processesMu.RLock()
	for _, e := range snapshot {
		if _, still := r.processes[e.id]; still {
			_ = syscall.Kill(-e.pid, syscall.SIGKILL)
		}
	}
	r.processesMu.RUnlock()

	r.wg.Wait()
}

// ExecuteCommand starts a command (after running any pre-hooks) and streams stdout+stderr as Wails events.
// runID scopes all events to this specific invocation so stale events from a prior run can never
// clear the Stop button while a new run is still active.
// Events emitted:
//
//	"output:<cmdID>:<runID>"    string        — one line of output
//	"done:<cmdID>:<runID>"      CommandResult — main process exit info
//	"post-done:<cmdID>:<runID>" CommandResult — post-hooks exit info (only if PostCommands set)
func (r *Runner) ExecuteCommand(ctx context.Context, cmd models.CommandConfig, workingDir string, runID string) string {
	r.storeCmdLabel(cmd.ID, cmd.Label)

	// Kill any prior run of this command (process-group kill to include children).
	r.processesMu.Lock()
	if prior, ok := r.processes[cmd.ID]; ok {
		pgid := prior.Process.Pid
		_ = syscall.Kill(-pgid, syscall.SIGTERM)
	}
	r.processesMu.Unlock()

	workDir := cmd.WorkingDir
	if workDir == "" {
		workDir = workingDir
	}

	outEvent := "output:" + cmd.ID + ":" + runID
	doneEvent := "done:" + cmd.ID + ":" + runID
	postDoneEvent := "post-done:" + cmd.ID + ":" + runID

	emit := func(line string) {
		if ctx != nil {
			wailsRuntime.EventsEmit(ctx, outEvent, line)
		}
	}

	r.wg.Add(1)
	go func() {
		defer r.wg.Done()

		if len(cmd.PostCommands) == 0 {
			// Pre-hooks + main command in one PTY session so that environment changes
			// in pre-hooks (eval, export, source, direnv) carry into the main command.
			var script strings.Builder
			script.WriteString("set -e\n")
			for i, preCmd := range cmd.PreCommands {
				escaped := strings.ReplaceAll(preCmd, "'", `'\''`)
				fmt.Fprintf(&script, "echo '[PRE] %d/%d: %s'\n", i+1, len(cmd.PreCommands), escaped)
				script.WriteString(preCmd + "\n")
				script.WriteString("wait\n")
			}
			script.WriteString(cmd.Command + "\n")

			exitCode, err := r.runShellCommand(cmd.ID, script.String(), workDir, emit)
			result := models.CommandResult{}
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
			exitCode, err := r.runShellCommand(cmd.ID, preScript.String(), workDir, emit)
			if err != nil || exitCode != 0 {
				result := models.CommandResult{ExitCode: exitCode}
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
			exitCode, err := r.runShellCommand(cmd.ID, cmd.Command, workDir, emit)
			result := models.CommandResult{ExitCode: exitCode}
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
			exitCode, err := r.runShellCommandCtx(tCtx, cmd.ID+":post", postCmd.Command, workDir, emit)
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
			result := models.CommandResult{ExitCode: postExitCode}
			if postErrStr != "" {
				result.Error = postErrStr
			}
			wailsRuntime.EventsEmit(ctx, postDoneEvent, result)
		}
	}()

	return "started"
}

func (r *Runner) runShellCommand(cmdID, shellCmd, workDir string, emit func(string)) (int, error) {
	return r.runShellCommandCtx(context.Background(), cmdID, shellCmd, workDir, emit)
}

// runShellCommandCtx runs one shell command synchronously, streaming output via emit.
// It uses a PTY so the child process sees a terminal and stays line-buffered.
// Cancelling ctx sends SIGTERM to the process (used for post-hook timeouts).
func (r *Runner) runShellCommandCtx(ctx context.Context, cmdID, shellCmd, workDir string, emit func(string)) (exitCode int, err error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "zsh"
	}
	// Use a non-login shell so ~/.zprofile is never sourced during command
	// execution — that's what triggered the brew CWD warning in terminal output.
	// Instead, inject the full login-shell PATH (captured once at startup) so
	// every user tool (adb, emulator, gradlew, brew, rbenv, nvm…) is reachable
	// regardless of whether the app was launched from a terminal or a DMG.
	c := exec.Command(shell, "-c", shellCmd)
	c.Dir = workDir
	env := os.Environ()
	fullPath := resolveLoginPath()
	replaced := false
	for i, e := range env {
		if strings.HasPrefix(e, "PATH=") {
			env[i] = "PATH=" + fullPath
			replaced = true
			break
		}
	}
	if !replaced {
		env = append(env, "PATH="+fullPath)
	}
	c.Env = env

	ptmx, startErr := pty.Start(c)
	if startErr != nil {
		return -1, fmt.Errorf("pty start: %w", startErr)
	}
	defer ptmx.Close()

	r.ptmxMu.Lock()
	r.ptmxWriters[cmdID] = ptmx
	r.ptmxMu.Unlock()
	defer func() {
		r.ptmxMu.Lock()
		if r.ptmxWriters[cmdID] == ptmx {
			delete(r.ptmxWriters, cmdID)
		}
		r.ptmxMu.Unlock()
	}()

	r.processesMu.Lock()
	r.processes[cmdID] = c
	r.processesMu.Unlock()
	defer func() {
		r.processesMu.Lock()
		if r.processes[cmdID] == c {
			delete(r.processes, cmdID)
		}
		r.processesMu.Unlock()
		// Prune the label cache so it doesn't grow unboundedly.
		r.cmdLabelsMu.Lock()
		delete(r.cmdLabels, cmdID)
		r.cmdLabelsMu.Unlock()
	}()

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
	buf := ptmxBufPool.Get().([]byte)
	defer ptmxBufPool.Put(buf)

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

	waitErr := c.Wait()
	if ctx.Err() != nil {
		return -1, fmt.Errorf("timed out or cancelled")
	}
	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			return exitErr.ExitCode(), nil
		}
		return -1, waitErr
	}
	return 0, nil
}

func (r *Runner) storeCmdLabel(cmdID, label string) {
	r.cmdLabelsMu.Lock()
	r.cmdLabels[cmdID] = label
	r.cmdLabelsMu.Unlock()
}
