//go:build windows

package main

import "github.com/wailsapp/wails/v2/pkg/menu/keys"

// Windows menu accelerators, chosen for how Windows *renders* them.
//
// Wails builds a Windows menu label as "<text>\t<Shortcut.String()>", and that
// String() comes from winc's virtual-key name table — where every punctuation key
// is spelled by its Win32 constant. So `keys.CmdOrCtrl("/")` appears in the menu
// as **Ctrl+OEM2**, and `CmdOrCtrl(",")` as **Ctrl+OEMComma**. The keys work; the
// labels are gibberish to anyone who has not read the Windows SDK.
//
// The name table is in an `internal` package of the Wails module, so it cannot be
// patched or replaced from here, and there is no way to supply the accelerator
// text ourselves — Wails always derives it. That leaves one option: on Windows,
// use accelerators that stringify into something a person recognises. Letters and
// function keys do; nothing punctuational does.
//
// See menu_keys_other.go for the macOS and Linux side, which keeps the
// conventional ⌘, and ⌘/ because AppKit renders those correctly.
// The modifier combinations winc can name at all. Its modifiers2string map is
// missing Ctrl+Alt entirely, so that combination stringifies to "" and the label
// collapses to the bare key — "S" on its own, which is worse than OEMComma
// because it looks like a working shortcut. Only Shift, Ctrl, Ctrl+Shift, Alt,
// Alt+Shift and Alt+Ctrl+Shift have names, which rules out the obvious Ctrl+Alt+S.
func settingsAccelerator() *keys.Accelerator {
	// Ctrl+, is the modern convention and is exactly what cannot be shown here.
	// Ctrl+Shift+S renders in full and collides with nothing else in this app —
	// there is no Save for it to be mistaken for.
	return keys.Combo("s", keys.CmdOrCtrlKey, keys.ShiftKey)
}

func shortcutsAccelerator() *keys.Accelerator {
	// F1 is not a compromise here: it is *the* Windows help key, so this is the
	// more idiomatic binding on this platform as well as the legible one.
	return keys.Key("F1")
}
