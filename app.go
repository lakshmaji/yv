package main

import (
	"context"
	"log"
	"os/exec"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func NewApp() *App {
	return &App{
		processes: make(map[string]*exec.Cmd),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctxMu.Lock()
	a.ctx = ctx
	a.ctxMu.Unlock()
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
