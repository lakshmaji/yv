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

// aboutEvent opens the About dialog, which is a frontend modal like every other
// one in the app rather than a native MessageDialog — a system alert box cannot
// lay out links and would be the only window here with OS chrome.
const aboutEvent = "open-about"

// updateMenuEvent opens the update dialog. Deliberately without an accelerator:
// it is a rare, deliberate action, and every obvious key here is already taken
// by something reached far more often.
const updateMenuEvent = "open-update"

// appMenu builds the macOS menu bar. It reconstructs the standard App / Edit /
// Window menus (which Wails provides automatically when no menu is set) and adds
// custom "View" and "Help" menus.
//
// Settings and About live under View and Help rather than in the canonical
// "yv › Settings…" / "yv › About yv" slots because menu.AppMenu() maps to the
// native AppMenuRole, which Wails builds in Objective-C and does not expose to
// Go — reaching those slots would mean hand-rolling the whole app menu and
// losing Hide Others / Services.
func appMenu(ctx func() context.Context) *menu.Menu {
	m := menu.NewMenu()
	m.Append(menu.AppMenu())

	view := menu.NewMenu()
	view.Append(menu.Text("Dashboard", keys.CmdOrCtrl("d"), func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(ctx(), "open-dashboard")
	}))
	view.Append(menu.Separator())
	view.Append(menu.Text("Settings…", settingsAccelerator(), func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(ctx(), "open-settings")
	}))
	m.Append(menu.SubMenu("View", view))

	m.Append(menu.EditMenu())
	m.Append(menu.WindowMenu())

	help := menu.NewMenu()
	help.Append(menu.Text("About yv", nil, func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(ctx(), aboutEvent)
	}))
	help.Append(menu.Text("Check for Updates…", nil, func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(ctx(), updateMenuEvent)
	}))
	help.Append(menu.Separator())
	help.Append(menu.Text("Keyboard Shortcuts", shortcutsAccelerator(), func(_ *menu.CallbackData) {
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
