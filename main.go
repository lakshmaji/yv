package main

import (
	"context"
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
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

		Mac: &mac.Options{
			TitleBar:             mac.TitleBarHiddenInset(),
			Appearance:           mac.DefaultAppearance,
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
		},
	})
	if err != nil {
		log.Fatal("Error:", err)
	}
}
