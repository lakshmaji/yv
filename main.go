package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

// version is set at link time: -ldflags "-X main.version=0.1.0". The Makefile
// reads the number out of wails.json, and CI takes it from the tag, so there is
// no second place to bump.
//
// It stays "dev" otherwise, and that is load bearing rather than cosmetic — a
// build that does not know its own version cannot meaningfully compare itself
// against a release feed, so "dev" is what keeps `wails dev` from offering to
// update itself into a real release.
var version = "dev"

func main() {
	app := NewApp(version)

	distFS, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		log.Fatal("frontend/dist embed:", err)
	}

	err = wails.Run(&options.App{
		Title:     "yv",
		Width:     1200,
		Height:    800,
		MinWidth:  900,
		MinHeight: 600,

		AssetServer: &assetserver.Options{
			Assets: distFS,
		},

		Bind: []any{app},

		Menu: appMenu(app.getCtx),

		OnStartup: func(ctx context.Context) {
			app.startup(ctx)
		},

		OnBeforeClose: func(ctx context.Context) (prevent bool) {
			running := app.GetRunningCommands()
			if len(running) == 0 {
				return false
			}

			result, err := wailsRuntime.MessageDialog(ctx, wailsRuntime.MessageDialogOptions{
				Type:          wailsRuntime.QuestionDialog,
				Title:         "Quit yv?",
				Message:       fmt.Sprintf("%d command(s) are still running. Kill all and quit?", len(running)),
				Buttons:       []string{"Quit", "Cancel"},
				DefaultButton: "Cancel",
				CancelButton:  "Cancel",
			})
			if err != nil || result != "Quit" {
				return true
			}

			app.StopAllCommands()
			return false
		},

		OnShutdown: func(ctx context.Context) {
			// StopAllCommands waits for every ExecuteCommand goroutine, so all
			// in-flight run records have landed before the metrics files close.
			app.StopAllCommands()
			app.closeMetrics()
			// Closes the libp2p host so this machine stops advertising itself
			// the moment the window goes away, rather than lingering as a
			// dinosaur on someone else's map until their TTL sweep.
			app.StopDiscovery()
		},

		Mac: &mac.Options{
			TitleBar: &mac.TitleBar{
				TitlebarAppearsTransparent: true,
				HideTitle:                  true,
				HideTitleBar:               false,
				FullSizeContent:            false,
				UseToolbar:                 false,
				HideToolbarSeparator:       true,
			},
			Appearance:           mac.DefaultAppearance,
			WebviewIsTransparent: true,
			WindowIsTranslucent:  false,
		},
	})
	if err != nil {
		log.Fatal("Error:", err)
	}
}
