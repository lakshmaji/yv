package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"syscall"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func NewApp() *App {
	return &App{
		processes:   make(map[string]*exec.Cmd),
		ptmxWriters: make(map[string]*os.File),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctxMu.Lock()
	a.ctx = ctx
	a.ctxMu.Unlock()
}

func (a *App) StopAllCommands() {
	a.processesMu.RLock()
	type entry struct {
		id  string
		pid int
	}
	snapshot := make([]entry, 0, len(a.processes))
	for id, cmd := range a.processes {
		if cmd.Process != nil {
			snapshot = append(snapshot, entry{id: id, pid: cmd.Process.Pid})
		}
	}
	a.processesMu.RUnlock()

	if len(snapshot) == 0 {
		return
	}

	for _, e := range snapshot {
		_ = syscall.Kill(-e.pid, syscall.SIGTERM)
	}

	time.Sleep(3 * time.Second)

	a.processesMu.RLock()
	for _, e := range snapshot {
		if _, still := a.processes[e.id]; still {
			_ = syscall.Kill(-e.pid, syscall.SIGKILL)
		}
	}
	a.processesMu.RUnlock()
}

// PickFolder opens a native macOS folder picker.
func (a *App) PickFolder() string {
	a.ctxMu.RLock()
	ctx := a.ctx
	a.ctxMu.RUnlock()

	path, err := wailsRuntime.OpenDirectoryDialog(ctx, wailsRuntime.OpenDialogOptions{
		Title: "Select project folder",
	})
	if err != nil {
		log.Printf("[PickFolder] %v", err)
		return ""
	}
	return path
}
