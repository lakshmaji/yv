package main

import (
	"context"
	"embed"
	"fmt"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend
var assets embed.FS

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "Nicosia",
		Width:     1200,
		Height:    800,
		MinWidth:  900,
		MinHeight: 600,

		AssetServer: &assetserver.Options{
			Assets: assets,
		},

		Bind: []any{app},

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
				Title:         "Quit Nicosia?",
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
			app.StopAllCommands()
		},

		Mac: &mac.Options{
			TitleBar: &mac.TitleBar{
				TitlebarAppearsTransparent: true,
				HideTitle:                 true,
				HideTitleBar:              false,
				FullSizeContent:           false,
				UseToolbar:                false,
				HideToolbarSeparator:      true,
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
