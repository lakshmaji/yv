# yv

A local dev command runner for macOS. Create projects, attach shell commands, and run them with live streaming output — all from a clean desktop app.

This is an open source project.

---

## Features

- **Projects & Groups** — organise commands by project and group (e.g. Android, iOS, Backend)
- **Live terminals** — per-command collapsible inline terminals with streaming stdout/stderr
- **Pre-hooks** — run setup commands (e.g. `direnv exec .`) before the main command
- **Post-commands** — run cleanup commands after the main command exits
- **Shortcuts** — named sequences that run multiple commands in order
- **Interactive mode** — send stdin, Ctrl+C, and Ctrl+D to running processes
- **Resource badges** — live CPU and memory usage per running command
- **Export / Import** — back up or share project configs as JSON or YAML

---

## Requirements

- macOS (ARM64 / Apple Silicon)
- [Go 1.24+](https://go.dev/dl/)
- [Node.js 18+](https://nodejs.org/)
- [Wails v2](https://wails.io/docs/gettingstarted/installation)

Install Wails:

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
```

---

## Development

```bash
make run      # start the app in dev mode (hot reload)
make test     # run all Go unit tests
make fmt      # format Go source files
```

---

## Build a release DMG (no Apple Developer account needed)

### 1. Build the app bundle

```bash
wails build -platform darwin/arm64
```

Output: `build/bin/yv.app`

### 2. Package as a DMG

macOS includes `hdiutil` — no extra tools needed:

```bash
mkdir -p dist
cp -r build/bin/yv.app dist/

hdiutil create \
  -volname "yv" \
  -srcfolder dist \
  -ov \
  -format UDZO \
  yv.dmg
```

This produces `yv.dmg` in the project root.

### 3. Distribute

Share the `.dmg` file directly (GitHub Releases, direct download, etc.).

> **Note for users opening the app for the first time:**
> Because the app is unsigned, macOS Gatekeeper will show _"cannot be opened because the developer cannot be verified"_.
>
> To open it:
> 1. Right-click (or Control-click) `yv.app` → **Open**
> 2. Click **Open** in the dialog
>
> This only needs to be done once. After that, the app opens normally.
>
> Alternatively, remove the quarantine flag from Terminal:
> ```bash
> xattr -d com.apple.quarantine /Applications/yv.app
> ```

---

## Config location

Projects are saved at:

```
~/Library/Application Support/yv/projects.json
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | [Wails v2](https://wails.io/) |
| Backend | Go 1.24 |
| Frontend | SolidJS + TypeScript |
| PTY | [creack/pty](https://github.com/creack/pty) |

---

## License

MIT
