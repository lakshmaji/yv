package main

import (
	"context"

	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	helpRepoURL   = "https://github.com/lakshmaji/yv"
	helpIssuesURL = "https://github.com/lakshmaji/yv/issues"
)

// appMenu builds the macOS menu bar. It reconstructs the standard App / Edit /
// Window menus (which Wails provides automatically when no menu is set) and adds
// a custom "Help" menu next to "Window".
func appMenu(ctx func() context.Context) *menu.Menu {
	m := menu.NewMenu()
	m.Append(menu.AppMenu())
	m.Append(menu.EditMenu())
	m.Append(menu.WindowMenu())

	help := menu.NewMenu()
	help.Append(menu.Text("Keyboard Shortcuts", keys.CmdOrCtrl("/"), func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(ctx(), "open-keyboard-shortcuts")
	}))
	help.Append(menu.Separator())
	help.Append(menu.Text("yv on GitHub", nil, func(_ *menu.CallbackData) {
		wailsRuntime.BrowserOpenURL(ctx(), helpRepoURL)
	}))
	help.Append(menu.Text("Report an Issue…", nil, func(_ *menu.CallbackData) {
		wailsRuntime.BrowserOpenURL(ctx(), helpIssuesURL)
	}))
	m.Append(menu.SubMenu("Help", help))

	return m
}
