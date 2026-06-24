# Nicosia — Context for Next Session

## What this app is

Wails v2 desktop app (macOS ARM64) — a local dev command runner. Users create projects, each with a folder path and a list of shell commands. Commands stream stdout/stderr into per-row collapsible inline terminals with Run/Stop buttons.

## Current state (branch: main)

All files are committed. The app compiles and runs with `make run` from the project root.

```
nicosia/
├── main.go          — Wails bootstrap
├── app.go           — lifecycle only: NewApp, startup, PickFolder
├── models.go        — all struct types + ansiRe regex
├── config.go        — persistence: LoadProjects, SaveProjects, UpdateProject, Export*, Import*, defaultProjects
├── runner.go        — PTY execution: runShellCommandCtx, ExecuteCommand, StopCommand, GetRunningCommands
├── go.mod / go.sum  — Wails v2.10.1
├── wails.json       — macOS ARM64 config
├── Makefile         — `make run` installs wails CLI if needed then runs `wails dev`
└── frontend/
    ├── index.html   — layout + styles (loads src/main.js as ES module)
    ├── main.js      — legacy file, no longer loaded
    └── src/
        ├── main.js      — bootstrap entry point: DOMContentLoaded wiring, initial load
        ├── state.js     — all shared mutable state + setter functions
        ├── utils.js     — escHtml, lineHtml, uid, selectedProject
        ├── terminal.js  — per-command terminal DOM ops (toggle, append, clear, badges, running state tracking)
        ├── commands.js  — runCommand, runShortcut, shortcut step tracking
        ├── modals.js    — edit-command modal, project-settings modal
        ├── shortcuts.js — shortcut cards, shortcut editor modal
        ├── resize.js    — applyColumnWidths, toggleSidebar, initResize
        └── render.js    — renderSidebar, renderGroups, renderMain, buildCmdRow, addCommand, addGroup
```

Config persisted at: `~/Library/Application Support/nicosia/projects.json`

### Current data model

```go
type Shortcut struct {
    ID         string   `json:"id"`
    Name       string   `json:"name"`
    CommandIDs []string `json:"commandIds"`
}

type Project struct {
    ID         string          `json:"id"`
    Name       string          `json:"name"`
    WorkingDir string          `json:"workingDir"`
    Groups     []string          `json:"groups"`
    GroupPaths map[string]string `json:"groupPaths,omitempty"`
    Commands   []CommandConfig   `json:"commands"`
    Shortcuts  []Shortcut        `json:"shortcuts,omitempty"`
}

type PostCommand struct {
    Command string `json:"command"`
    Timeout int    `json:"timeout,omitempty"` // seconds; 0 = default (120)
}

type CommandConfig struct {
    ID           string        `json:"id"`
    Label        string        `json:"label"`
    Command      string        `json:"command"`
    Group        string        `json:"group"`
    WorkingDir   string        `json:"workingDir,omitempty"`
    PreCommands  []string      `json:"preCommands,omitempty"`
    PostCommands []PostCommand `json:"postCommands,omitempty"`
    Interactive  bool          `json:"interactive,omitempty"`
}
```

`Groups` on `Project` holds explicitly created groups (from the "+ Add Group" button). Groups are also derived implicitly from distinct `Group` values on commands. The rendered list merges both sources.

### Seed data (POS project)

- Name: `POS`
- WorkingDir: `/Users/lakshmaji/conductor/workspaces/pos-redeem-gf-v1/hot-updater-integration/pos-app/android`
- Commands (all Android):
  - Clean & Build Release APK — `./gradlew clean && ./gradlew app:assembleRelease`
  - Install APK — `adb install -r app/build/outputs/apk/release/app-release.apk`
  - Launch App — `adb shell am start -n au.oolio.pos/.MainActivity`
  - Force Stop App — `adb shell am force-stop au.oolio.pos`
  - Start Pixel Tablet Emulator — `emulator -avd Pixel_Tablet -no-snapshot-load`
  - List AVDs — `emulator -list-avds`

---

## Implemented: Secondary group nav panel

### Goal

Add a second column between the project sidebar and the command list. Commands within a project are grouped (e.g. "Android", "iOS"). The secondary panel lets users filter by group.

### Layout

```
┌──────────┬─────────────┬──────────────────────────────────┐
│ Projects │  Groups     │  Commands (filtered by group)    │
│ ──────── │  ────────── │  ──────────────────────────────  │
│ ● POS    │  ● Android  │  Clean & Build Release APK       │
│          │    iOS      │  Install APK                     │
│ + New    │  + Add      │  Launch App  …                   │
└──────────┴─────────────┴──────────────────────────────────┘
```

### Data model change

Add `Group` field to `CommandConfig`:

```go
type CommandConfig struct {
    ID      string `json:"id"`
    Label   string `json:"label"`
    Command string `json:"command"`
    Group   string `json:"group"`   // ← NEW
}
```

- Groups are **derived** from distinct `group` values on the project's commands — no separate groups array.
- Update `defaultProjects()` seed: all 6 POS commands get `Group: "Android"`.

### Secondary panel behaviour

- Lists unique groups for the selected project (sorted alphabetically) + "All" at top
- Clicking a group filters the command list to that group only
- "All" shows every command regardless of group
- Switching projects resets selection to "All"
- "Add Command" form gets a **Group** input (pre-filled with currently selected group)
- Groups with no commands disappear automatically (derived, not stored)

### Files changed

| File | Change |
|---|---|
| `app.go` | Added `Group string` to `CommandConfig`, `Groups []string` to `Project`; seeded all POS commands with `Group: "Android"` |
| `frontend/index.html` | Added `#groups-panel` middle column to CSS grid (3-column layout) |
| `frontend/main.js` | Added `renderGroups()`, `selectedGroup` state, filter commands in `renderMain()`, group field in add-command form |

---

## Implemented: Export / Import projects

### Goal

Allow users to back up or share their full projects config (projects, groups, commands) as a file, and restore it on another machine or after accidental deletion.

### Formats supported

- **JSON** (`.json`) — default, matches internal storage format
- **YAML** (`.yaml` / `.yml`) — human-friendly for hand-editing and sharing

Format is determined by the file extension chosen in the save/open dialog. No separate format toggle.

### Behaviour

- **Export**: opens a native save dialog (`nicosia-projects.json` default name, JSON and YAML filters). Writes all current projects to the chosen file.
- **Import**: opens a native open dialog (JSON/YAML filter). Merges incoming projects into the existing config by ID — projects with a new ID are appended, projects whose ID already exists are skipped (no overwrite). Reports a summary: `"Imported N project(s), skipped M (already exist)"`.
- Cancelling either dialog is a silent no-op.

### Files changed

| File | Change |
|---|---|
| `go.mod` / `go.sum` | Added `gopkg.in/yaml.v3 v3.0.1` |
| `app.go` | Added `marshalProjects`, `unmarshalProjects` helpers; `ExportProjects()` and `ImportProjects()` methods |
| `frontend/index.html` | Added `#data-actions` div with `↑ Export` / `↓ Import` buttons at sidebar bottom; hidden when sidebar is collapsed |
| `frontend/main.js` | Wired click handlers for both buttons; `ImportProjects` reloads and re-renders the full project list on success |

---

## Implemented: Pre-hook commands per command

### Goal

Each command can have an ordered list of shell commands that run and complete before the main command starts. Useful for environment setup steps like `nvm use 18` or `source .env`.

### Behaviour

- Pre-hooks run sequentially in the same working directory as the main command
- If any pre-hook exits non-zero, the main command is **not** started; the row goes red
- Pre-hook output streams into the same inline terminal, prefixed with `[PRE] N/M: <cmd>` (dim italic styling)
- Stop during a pre-hook kills the current pre-hook process; row goes `done-stopped` grey
- A `"N hooks"` badge appears on the command row header when pre-hooks are configured

### Edit modal

A pencil `✎` button on each command row opens an edit modal with:
- Editable label, group, shell command, working dir
- Dynamic pre-hooks list: add rows with `+ Add pre-hook`, delete with `✕`, reorder by drag (not yet)
- Save persists all changes; Cancel / Escape / backdrop click discards

### Files changed

| File | Change |
|---|---|
| `app.go` | Added `PreCommands []string` to `CommandConfig`; extracted `runShellCommand` helper; `ExecuteCommand` runs pre-hooks sequentially before main command |
| `frontend/index.html` | Added edit modal HTML; CSS for modal overlay, pre-hook rows, `.pre-count-badge`, `.edit-btn`, `.line-pre` |
| `frontend/main.js` | `openEditModal` / `closeEditModal` / `addPreHookRow`; pencil button + badge in `buildCmdRow`; `[PRE]` prefix detection in `lineHtml` |

---

## Implemented: Shortcuts

### Goal

Allow users to create named shortcuts that run a selected set of commands sequentially (including each command's pre-hooks). If any command fails (non-zero exit), subsequent commands are skipped.

### Behaviour

- Shortcuts are per-project and persisted in `projects.json` via `Shortcuts []Shortcut` on `Project`
- A **Shortcuts section** appears at the top of the main panel (above the command list) for the selected project
- Each shortcut card shows: name, step pills (one per command), Edit `✎`, Delete `✕`, and `▶ Run` buttons
- Step pills update live during execution: default → `running` (blue) → `ok` (green) / `failed` (red) / `skipped` (faded)
- The shortcut card border changes colour: blue while running, green on full success, red on failure
- The `▶ Run` button is disabled while the shortcut is executing to prevent double-trigger
- Clicking Stop on the active command row halts the shortcut at that step (relies on the existing `StopCommand` flow)
- Commands deleted after a shortcut was saved are silently skipped during execution (their pill shows "deleted" in red italic in the edit modal)

### Create / Edit modal

- `+ New Shortcut` button in the shortcuts section header opens the modal
- Name field + scrollable list of all project commands as checkboxes
- Commands can be **drag-reordered** via the `⠿` handle on the left of each row — drag only activates from the handle, so checkbox toggling is unaffected
- When editing, checked commands render in their **saved execution order** first; unchecked commands appear below
- Save reads command IDs in current **DOM order** (respecting any reordering), filtered to checked rows

### `runCommand` change

`runCommand(cmd)` now returns `Promise<number>` (exit code), resolving inside the `done:` event handler. Existing fire-and-forget callers (the per-row Run button) are unaffected. This allows `runShortcut` to `await` each step sequentially.

### Files changed

| File | Change |
|---|---|
| `app.go` | Added `Shortcut` struct; added `Shortcuts []Shortcut` to `Project` (`omitempty` — no migration needed) |
| `frontend/index.html` | Added shortcut section + card CSS; drag handle + dragging-state CSS; `#sc-modal` HTML |
| `frontend/main.js` | `runCommand` returns `Promise<exitCode>`; added `runShortcut`, `setShortcutRunning`, `setShortcutStep`, `renderShortcuts`, `buildShortcutCard`, `openShortcutModal`, `closeShortcutModal`, `saveShortcut`, `deleteShortcut`, `initShortcutDrag`; `renderMain()` updated to include shortcuts section |

---

## Implemented: Change Path (project header)

### Goal

Move the working directory control out of the add-command form and into the project header as a "Change Path" button. The button is group-aware: each group can have an optional path override, and "All" simply displays the project path with no button.

### Layout

```
┌──────────────────────────────────────────────────────────────┐
│  POS  /path/to/project                         Change Path   │  ← specific group selected
│  POS  /path/to/project                                       │  ← "All" selected (no button)
└──────────────────────────────────────────────────────────────┘
```

### Behaviour

- When **"All"** is selected: project `workingDir` is shown, no "Change Path" button
- When a **specific group** is selected: the group's path override is shown (falls back to project `workingDir` if none set); "Change Path" button is visible
- Clicking "Change Path" opens the native folder picker; chosen path is saved to `proj.groupPaths[groupName]`
- The add-command form is now a single row (Label + Group + Command + Add Command); the per-command working dir is still editable via the edit (pencil) modal

### Data model change

Added `GroupPaths` to `Project`:

```go
type Project struct {
    ...
    GroupPaths map[string]string `json:"groupPaths,omitempty"`
    ...
}
```

`GroupPaths` is a map from group name → working dir override. `omitempty` means no migration needed for existing data.

### Files changed

| File | Change |
|---|---|
| `app.go` | Added `GroupPaths map[string]string` to `Project` (`omitempty`) |
| `frontend/index.html` | Added `#change-path-btn` CSS; changed `#project-header` to `align-items: center` |
| `frontend/main.js` | `renderMain()` computes `displayPath` (group override or project path) and conditionally renders button; Change Path handler saves to `proj.groupPaths[selectedGroup]`; add-command form removed working dir row; `addCommand()` no longer reads a dir input |

---

## Implemented: Code reorganization for maintainability

### Goal

Split the two large monolithic files (`app.go` at 716 lines, `frontend/main.js` at 1,098 lines) into single-responsibility modules with no behavior change.

### Go backend split

`app.go` → 4 files, all in `package main`:

| File | Responsibility |
|---|---|
| `models.go` | All struct types (`Shortcut`, `Project`, `PostCommand`, `CommandConfig`, `CommandResult`, `App`) + `ansiRe` |
| `app.go` | Wails lifecycle only: `NewApp`, `startup`, `PickFolder` |
| `config.go` | All persistence: `LoadProjects`, `SaveProjects`, `UpdateProject`, Export/Import methods, `configPath`, `writeProjects`, marshal/unmarshal helpers, `defaultProjects` |
| `runner.go` | PTY execution engine: `runShellCommandCtx`, `runShellCommand`, `ExecuteCommand`, `StopCommand` |

### Frontend split

`frontend/main.js` → 9 ES modules under `frontend/src/`. The script tag in `index.html` changed to `<script type="module" src="src/main.js">`.

Key design points:
- `state.js` exports all mutable state as `let` with paired setter functions — necessary because ES module importers can't reassign exported bindings directly.
- `shortcuts.js` imports `renderMain` from `render.js` (circular), which is safe because the import is only called inside async event handlers, never at module init time.
- `render.js` contains `buildCmdRow` (not `commands.js`) to keep the import graph acyclic on the render side.

### Files changed

| File | Change |
|---|---|
| `app.go` | Reduced to lifecycle + PickFolder (~37 lines) |
| `models.go` | New — all type definitions |
| `config.go` | New — all persistence logic |
| `runner.go` | New — all PTY/execution logic |
| `frontend/index.html` | Script tag: `src="main.js"` → `type="module" src="src/main.js"` |
| `frontend/src/` | New directory with 9 ES modules (state, utils, terminal, commands, modals, shortcuts, resize, render, main) |

---

## Fixed: Group path not respected when running commands

### Problem

When a group had a `groupPaths` override set via "Change Path", commands in that group still ran in `proj.workingDir` (the project root) instead of the group-specific path. The group path was stored and displayed correctly in the header, but not forwarded to `ExecuteCommand`.

### Root cause

`runCommand()` in `frontend/src/commands.js` passed `proj.workingDir` unconditionally as the fallback working directory to `go.ExecuteCommand(cmd, proj.workingDir, runID)`.

### Fix

`runCommand` now resolves the effective working directory before calling Go:

```js
const workingDir = (selectedGroup !== 'All' && proj.groupPaths?.[selectedGroup])
  ? proj.groupPaths[selectedGroup]
  : proj.workingDir;
await go.ExecuteCommand(cmd, workingDir, runID);
```

The Go side (`ExecuteCommand`) uses this as the fallback when `cmd.WorkingDir` is empty, so per-command working dir overrides still take priority.

### Files changed

| File | Change |
|---|---|
| `frontend/src/commands.js` | Import `selectedGroup` from `state.js`; resolve group path override before calling `ExecuteCommand` |

---

## Fixed: Running terminal state lost on project switch

### Problem

When a user started a long-running command (e.g., emulator, dev server) in Project A, then switched to Project B and back, the command row showed "Run" instead of "Stop" even though the command was still running in the Go backend. Running counts were also not visible anywhere.

### Root cause

The "running" state was tracked **only** as a CSS class (`.running`) on the DOM element. `cmdState` had no `running` field. When switching projects, `renderMain()` rebuilds the entire DOM via `buildCmdRow()`, which only sets classes based on `exitCode` (done-ok, done-err, done-stopped) — never `.running`. The CSS class was silently lost.

### Fix

1. **Track running in data, not just CSS**: `setRowRunning()` in `terminal.js` now writes `state.running` to `cmdState` alongside the DOM class toggle. This is the single chokepoint for all running-state transitions.
2. **Restore on DOM rebuild**: `buildCmdRow()` in `render.js` reads `state.running` and applies the `.running` class when building rows.
3. **Go-side safety net**: New `GetRunningCommands()` method in `runner.go` exposes the `a.processes` map keys (filtering `:post` suffixed entries). `renderMain()` calls it asynchronously after rendering to re-sync state after hot-reload.
4. **Global running count**: `updateRunningCount()` in `terminal.js` updates the sidebar header text to "Projects (N)" and sets per-project count badges + green dots on sidebar project items.

### Frontend state shape change

```
cmdState per entry: { lines, collapsed, exitCode, stopped, running }
//                                                         ^^^^^^^ NEW
```

### Files changed

| File | Change |
|---|---|
| `runner.go` | New `GetRunningCommands()` method — returns IDs of running processes (excludes `:post` suffixed post-hook entries) |
| `frontend/src/terminal.js` | `setRowRunning()` writes `cmdState.running`; new `updateRunningCount()` updates sidebar header total, per-project count badges, and green dots |
| `frontend/src/render.js` | `buildCmdRow()` applies `.running` from state; `renderMain()` calls `GetRunningCommands()` for re-sync; default state includes `running: false` |
| `frontend/src/commands.js` | Default state in `runCommand()` includes `running: false` |
| `frontend/src/main.js` | Calls `updateRunningCount()` on initial load |
| `frontend/index.html` | CSS for `.project-running-count` badge, `.has-running` green dot, collapsed sidebar hiding |

---

## Implemented: Interactive command mode

### Goal

Allow commands that prompt for user input (e.g. CLIs with `[y/N]` prompts, REPLs, password prompts) to receive stdin from the UI while they are running.

### Behaviour

- Commands can be marked **Interactive** via a checkbox in the edit modal; the setting is persisted in `projects.json`
- When an interactive command is running, a **stdin input field** appears below the terminal output with placeholder `Enter to send · Ctrl+C to interrupt · Ctrl+D for EOF`
- Pressing **Enter** in the field sends the typed text + newline to the process via `go.SendInput(cmdID, text + '\n')`
- Pressing **Ctrl+C** in the field sends ASCII `\x03` (SIGINT) to the process
- Pressing **Ctrl+D** in the field sends ASCII `\x04` (EOF) to the process
- The input field is hidden when the command is not running
- **Stop button** for interactive commands first sends Ctrl+C (`\x03`) to give the process a chance to clean up, then proceeds with SIGTERM/SIGKILL if needed
- PTY reader switched from `bufio.Scanner` to raw byte reads so prompts without a trailing newline (e.g. `Password: `) stream to the terminal immediately

### Data model change

Added `Interactive bool` to `CommandConfig`:

```go
type CommandConfig struct {
    ...
    Interactive  bool  `json:"interactive,omitempty"`
}
```

`omitempty` means no migration needed for existing commands (they default to non-interactive).

### New backend API

`App.SendInput(cmdID, text string) string` — writes `text` directly to the PTY stdin of the running command. Returns `"ok"`, `"not running"`, or `"error: <reason>"`.

Internal: `App.ptmxWriters map[string]*os.File` stores the open PTY file descriptor per running command ID, protected by `App.ptmxMu sync.RWMutex`.

### Files changed

| File | Change |
|---|---|
| `models.go` | Added `Interactive bool` to `CommandConfig` |
| `app.go` | `NewApp()` initializes `ptmxWriters` map; `App` struct gains `ptmxWriters map[string]*os.File` and `ptmxMu sync.RWMutex` |
| `runner.go` | PTY reader switched from `bufio.Scanner` to raw reads; registers/deregisters PTY writer in `ptmxWriters`; new `SendInput()` exported method |
| `frontend/index.html` | `.terminal-stdin` input field (visible only when row is `.running`); `edit-interactive` checkbox in edit modal |
| `frontend/src/render.js` | `buildCmdRow()` attaches keydown handler on stdin input (Enter / Ctrl+C / Ctrl+D); Stop button sends Ctrl+C first for interactive commands |
| `frontend/src/modals.js` | `openEditModal()` populates `edit-interactive` checkbox from `cmd.interactive` |
| `frontend/src/main.js` | Save handler reads `edit-interactive` and writes to `cmd.interactive` |
