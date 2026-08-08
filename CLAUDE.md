# yv — Context for Next Session

## What this app is

Wails v2 desktop app (macOS ARM64) — a local dev command runner. Users create projects, each with a folder path and a list of shell commands. Commands stream stdout/stderr into per-row collapsible inline terminals with Run/Stop buttons.

## Current state (branch: main)

All files are committed. The app compiles and runs with `make run` from the project root.

```
yv/
├── main.go          — Wails bootstrap, mac title bar config, quit dialog
├── app.go           — App facade: NewApp, startup, PickFolder, startFullscreenMonitor,
│                      thin delegating wrappers for all Wails-bound methods
├── models.go        — type aliases re-exporting internal/models under package main
│                      (keeps Wails TypeScript namespace as "main.*")
├── go.mod / go.sum  — Wails v2.10.1
├── wails.json       — macOS ARM64 config
├── Makefile         — make run / make fmt / make test
├── internal/
│   ├── models/
│   │   └── models.go   — all struct types: Project, CommandConfig, Shortcut, PostCommand,
│   │                      CommandResult, ProcessStats, ResourceStats, ProcessEntry
│   ├── runner/
│   │   └── runner.go   — Runner struct: PTY execution, ExecuteCommand, StopCommand,
│   │                      SendInput, GetRunningCommands, StopAll, GetProcessSnapshot
│   ├── config/
│   │   └── config.go   — Store struct (stateless): LoadProjects, SaveProjects, UpdateProject,
│   │                      ExportProject(s), ImportProject(s), defaultProjects
│   └── monitor/
│       └── monitor.go  — Monitor struct: resource stats polling (CPU, memory),
│                          GetResourceStats, parsePsOutput
└── frontend/
    ├── index.html   — HTML shell (loads src/index.tsx)
    └── src/
        ├── index.tsx    — SolidJS render entry point
        ├── App.tsx      — root component: project loading, keydown, column resize, fullscreen event listener
        ├── store.ts     — SolidJS signals: projects, selectedId, selectedGroup, cmdState, sidebarWidth, etc.
        ├── types.ts     — TypeScript interfaces (Project, CommandConfig, Shortcut, etc.)
        ├── wails.ts     — typed Go bindings (GoApp interface) + runtime re-export
        ├── styles.css   — all app styles (CSS variables, grid layout, components)
        ├── lib/
        │   ├── commands.ts  — runCommand, runShortcut, shortcut step tracking
        │   └── utils.ts     — escHtml, lineHtml, uid helpers
        └── components/
            ├── Sidebar.tsx          — project list, new project form, export/import
            ├── GroupsPanel.tsx       — group list, add group form
            ├── MainPanel.tsx         — project header, command list, add command form
            ├── CommandRow.tsx        — single command row with terminal, run/stop, stdin
            ├── Terminal.tsx          — terminal output rendering
            ├── ShortcutsSection.tsx  — shortcuts header + card list
            ├── ShortcutCard.tsx      — individual shortcut with step pills
            ├── StatusBar.tsx         — resource stats (CPU, memory, command count)
            ├── ResizeHandle.tsx      — draggable column resize
            └── modals/
                ├── EditCommandModal.tsx     — edit command, pre-hooks, post-commands
                ├── ShortcutModal.tsx        — create/edit shortcut, drag-reorder
                └── ProjectSettingsModal.tsx — project name, working dir, delete
```

Config persisted at: `~/Library/Application Support/yv/projects.json`

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

- **Export**: opens a native save dialog (`yv-projects.json` default name, JSON and YAML filters). Writes all current projects to the chosen file.
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

### Phase 1 — frontend split

`frontend/main.js` → 9 ES modules under `frontend/src/`. The script tag in `index.html` changed to `<script type="module" src="src/main.js">`.

Key design points:
- `state.js` exports all mutable state as `let` with paired setter functions — necessary because ES module importers can't reassign exported bindings directly.
- `shortcuts.js` imports `renderMain` from `render.js` (circular), which is safe because the import is only called inside async event handlers, never at module init time.
- `render.js` contains `buildCmdRow` (not `commands.js`) to keep the import graph acyclic on the render side.

### Phase 2 — Go backend split into `internal/` packages

The flat `package main` layout was replaced with proper Go internal packages. `app.go` is now a thin Wails-bound facade; all business logic lives in `internal/`.

| Package | Owner | Key types/funcs |
|---|---|---|
| `internal/models` | Data types only | `Project`, `CommandConfig`, `Shortcut`, `PostCommand`, `CommandResult`, `ProcessStats`, `ResourceStats`, `ProcessEntry` |
| `internal/runner` | PTY execution | `Runner` struct, `ExecuteCommand`, `StopCommand`, `SendInput`, `GetRunningCommands`, `StopAll`, `GetProcessSnapshot` |
| `internal/config` | Persistence | `Store` struct (stateless), `LoadProjects`, `SaveProjects`, `UpdateProject`, `ExportProject(s)`, `ImportProject(s)` |
| `internal/monitor` | Resource stats | `Monitor` struct, `Start(ctx)`, `GetResourceStats`, `parsePsOutput` |

**Import graph** (no cycles): `models` ← `runner`, `config`, `monitor`; `monitor` also imports `runner`.

**Wails namespace preservation:** Root `models.go` keeps Go type aliases (`type Project = models.Project` etc.) so Wails generates TypeScript bindings in the `main` namespace — zero frontend changes required.

**Memory/GC improvements made during this refactor:**
- `sync.Pool` for the 32 KB PTY read buffer — avoids a heap allocation per read loop iteration
- `cmdLabels` map pruned on process exit — was unbounded before
- Background goroutines (resource monitor + fullscreen monitor) now exit via `ctx.Done()` on shutdown
- `Runner.StopAll` uses a `sync.WaitGroup` and waits for all `ExecuteCommand` goroutines after SIGKILL
- `startFullscreenMonitor` replaced its `time.Sleep(300ms)` poll with a ticker + select

**Table-driven unit tests** added for all four internal packages (`*_test.go` alongside each package). Run with `make test`.

### Makefile commands

| Command | Action |
|---|---|
| `make run` | Install wails CLI if needed, then `wails dev` |
| `make fmt` | `gofmt -w` all `.go` files (skips `wailsjs/` generated files) |
| `make test` | `go test ./internal/... -v` — runs all 25 table-driven tests |

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

## Fixed: Group path override ignored when viewing "All" group

### Problem

When `selectedGroup` was `'All'`, commands that belonged to a group with a `groupPaths` override still ran in `proj.workingDir` (the project root). The fix above only applied when the user had explicitly selected the group — switching back to "All" lost the path context.

### Root cause

The working directory resolution in `runCommand()` short-circuited to `proj.workingDir` any time `selectedGroup === 'All'`, without checking whether the command's own `cmd.group` had a path override.

### Fix

Resolve the effective group from the command itself when in "All" view:

```js
const effectiveGroup = selectedGroup !== 'All' ? selectedGroup : cmd.group;
const workingDir = (effectiveGroup && proj.groupPaths?.[effectiveGroup])
  ? proj.groupPaths[effectiveGroup]
  : proj.workingDir;
```

Commands now use their group's path override regardless of which view they are triggered from. Per-command `WorkingDir` overrides still take priority (handled on the Go side).

### Files changed

| File | Change |
|---|---|
| `frontend/src/commands.js` | Derive `effectiveGroup` from `cmd.group` when `selectedGroup === 'All'`; use it for path resolution |

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
| `internal/runner/runner.go` | New `GetRunningCommands()` method — returns IDs of running processes (excludes `:post` suffixed post-hook entries) |
| `frontend/src/components/Terminal.tsx` | `setRowRunning()` writes `cmdState.running`; new `updateRunningCount()` updates sidebar header total, per-project count badges, and green dots |
| `frontend/src/components/CommandRow.tsx` | `buildCmdRow()` applies `.running` from state; `renderMain()` calls `GetRunningCommands()` for re-sync; default state includes `running: false` |
| `frontend/src/lib/commands.ts` | Default state in `runCommand()` includes `running: false` |
| `frontend/src/App.tsx` | Calls `updateRunningCount()` on initial load |
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
| `internal/models/models.go` | Added `Interactive bool` to `CommandConfig` |
| `app.go` | `NewApp()` initializes `ptmxWriters` map; `App` struct gains `ptmxWriters map[string]*os.File` and `ptmxMu sync.RWMutex` |
| `internal/runner/runner.go` | PTY reader switched from `bufio.Scanner` to raw reads; registers/deregisters PTY writer in `ptmxWriters`; new `SendInput()` exported method |
| `frontend/index.html` | `.terminal-stdin` input field (visible only when row is `.running`); `edit-interactive` checkbox in edit modal |
| `frontend/src/components/CommandRow.tsx` | `buildCmdRow()` attaches keydown handler on stdin input (Enter / Ctrl+C / Ctrl+D); Stop button sends Ctrl+C first for interactive commands |
| `frontend/src/components/modals/EditCommandModal.tsx` | `openEditModal()` populates `edit-interactive` checkbox from `cmd.interactive` |
| `frontend/src/App.tsx` | Save handler reads `edit-interactive` and writes to `cmd.interactive` |

---

## Implemented: Frontend migration to SolidJS + TypeScript

### Goal

Replace the vanilla JS frontend with SolidJS + TypeScript for type safety, reactive state management, and component-based architecture.

### Key changes

- All `.js` files under `frontend/src/` replaced with `.tsx`/`.ts` SolidJS components
- State management moved from manual setter functions to SolidJS signals (`store.ts`)
- DOM manipulation replaced with SolidJS reactive JSX
- Entry point changed from `main.js` → `index.tsx` (renders `<App />` into `#root`)
- Wails Go bindings typed via `GoApp` interface in `wails.ts`
- All types defined in `types.ts`

---

## Implemented: Native transparent title bar with fullscreen detection

### Goal

Remove the hard-coded "yv" title from the window header and eliminate wasted vertical space. In windowed mode, the macOS traffic light buttons (close/minimize/maximize) need clearance. In fullscreen, traffic lights auto-hide so no clearance is needed.

### Approach

Uses a native macOS transparent title bar (not `TitleBarHiddenInset`) combined with a Go-side fullscreen monitor that pushes state changes to the frontend via events.

### macOS title bar config (`main.go`)

```go
Mac: &mac.Options{
    TitleBar: &mac.TitleBar{
        TitlebarAppearsTransparent: true,
        HideTitle:                 true,
        HideTitleBar:              false,
        FullSizeContent:           false,
        UseToolbar:                false,
        HideToolbarSeparator:      true,
    },
    WebviewIsTransparent: true,
}
```

- `TitlebarAppearsTransparent: true` — title bar blends with the app background
- `HideTitle: true` — no title text shown in the native title bar
- `FullSizeContent: false` — web content stays below the title bar (but Wails webview still extends into it, so padding is needed)

### Fullscreen detection

**Go side** (`app.go`): `startFullscreenMonitor()` — a goroutine that polls `wailsRuntime.WindowIsFullscreen(ctx)` every 300ms and emits a `fullscreen-changed` event (via `wailsRuntime.EventsEmit`) only when the state actually changes.

**Frontend** (`App.tsx`): listens for `fullscreen-changed` events via `runtime.EventsOn` and toggles `body.fullscreen` CSS class.

### CSS behaviour (`styles.css`)

Two states controlled by `body.fullscreen`:

- **Windowed** (default): `padding-top: 24px` on `#sidebar-header`, `#groups-header`, `#project-header` — clears the traffic light buttons
- **Fullscreen** (`body.fullscreen`): `padding-top: 12px` — no traffic lights visible, reclaims the space

### Collapsed sidebar

When the sidebar is collapsed, the following are hidden via CSS:
- `.project-running-count` (running count badge)
- `.project-settings-btn` (settings gear icon)

### App renamed

Window title and HTML `<title>` changed from "yv" to "yv". The `Header.tsx` component (which rendered the old full-width "yv" title bar) was deleted; its grid row removed from the body layout.

### Files changed

| File | Change |
|---|---|
| `main.go` | Title `"yv"` → `"yv"`; quit dialog title updated; `TitleBarHiddenInset()` → custom `TitleBar{}` with transparent + hidden title |
| `app.go` | New `startFullscreenMonitor()` goroutine; called from `startup()` |
| `frontend/src/App.tsx` | Removed `Header` import; added `fullscreen-changed` event listener toggling `body.fullscreen` class |
| `frontend/src/styles.css` | Removed header grid row (was `44px`); body grid now 2-row (`1fr 24px`); removed `#header` CSS; header padding-top 24px (windowed) / 12px (fullscreen); collapsed sidebar hides settings btn |
| `frontend/src/components/Header.tsx` | Deleted |
| `frontend/index.html` | `<title>yv</title>` → `<title>yv</title>` |

---

## Fixed: Per-command memory/CPU badge in command row

### Problem

The command row header used to show live resource usage (e.g. `31 MB · 0.1%`) while a command was running. After the SolidJS migration the placeholder `<span class="cmd-resource-badge">` existed in `CommandRow.tsx` but was statically hidden (`display: 'none'`) and never populated. The backend was already emitting `resource-stats` events with per-command stats — the data was available but not consumed.

### How it works

- `internal/monitor/monitor.go` polls every 3 seconds, collects `ps -o pid=,rss=,pcpu=` for all running processes, and emits a `resource-stats` Wails event with a `ResourceStats` struct containing `Commands []ProcessStats` (each entry has `CmdID`, `RSS` in bytes, `CPU` percent).
- The badge shows `"31 MB · 0.1%"` format using the existing `formatBytes()` utility.
- Badge is visible only when the command is running and stats are present; it disappears on stop/finish.

### Files changed

| File | Change |
|---|---|
| `frontend/src/store.ts` | Added `resourceStats` signal (`Map<string, ProcessStats>`) and exported it with its setter |
| `frontend/src/App.tsx` | Added `resource-stats` Wails event listener (alongside `fullscreen-changed`) that rebuilds the map on each tick and calls `setResourceStats`; cleaned up in `onCleanup` |
| `frontend/src/components/CommandRow.tsx` | Replaced static hidden span with reactive `<Show when={state().running && cmdStats()}>` that renders `formatBytes(rss) · cpu.toFixed(1)%` |

---

## Notes: direnv + AWS SSO in pre-hooks

Relevant when configuring pre-hook commands that need to load environment variables from `.envrc` before running a main command (e.g. `tilt up`).

### Commands that do NOT trigger SSO / load env

- `direnv allow .` — only writes a hash to `~/.config/direnv/allow/`. Does not evaluate `.envrc`. Exits immediately.
- `eval "$(direnv hook zsh)"` — installs `_direnv_hook` into `precmd_functions`. In a non-interactive shell (`zsh -l -c ...`, which is how yv runs all commands), `precmd_functions` are never called. The hook is defined but never fires. No SSO, no env vars loaded.

### Commands that DO trigger SSO / load env

- `eval "$(direnv export zsh)"` — evaluates `.envrc`. If `.envrc` triggers `aws sso login`, this blocks until browser auth completes. Env vars are applied to the current shell via `eval`. Downside: stdout is captured by `$()`, so the SSO URL won't be visible in the terminal (browser still opens via `open`).
- `direnv exec . <cmd>` — evaluates `.envrc` with full visible output, triggers SSO with URL shown, waits for completion, then runs `<cmd>` with the loaded env. Cleanest approach.

### PTY / browser note

The `open` command works in any Mac process regardless of PTY context, so the browser will open correctly from within yv's PTY-attached shell.

### Recommended pattern

Use `direnv exec .` as the main command wrapper instead of pre-hooks:

Pre-hooks:
1. `direnv allow .` ← only needed if `.envrc` might not be trusted yet

Main command:
```
direnv exec . tilt up
```

Remove `eval "$(direnv hook zsh)"` from pre-hooks — it does nothing in a non-interactive shell and is misleading.

---

## Implemented: Global Spotlight search

### Goal

macOS Spotlight-style command palette: one keystroke from anywhere finds any command in **any** project, over a blurred backdrop.

### Behaviour

- `⌘K` (or `⌘F`) opens a centered overlay; a `⌕ Search ⌘K` button **at the top of the sidebar, directly above the project list**, does the same. Collapsing the sidebar reduces it to the `⌕` icon. `Esc` or a backdrop click closes it.
- **Global scope**: searches every command of every project. Matches on command label, shell text, group, *project name*, and **pre/post hook commands** — so `storefront install` finds the `Install deps` command inside the Storefront project, and `direnv` finds a command whose pre-hook runs `direnv allow .`.
- A query is split on whitespace; a command matches only if **every** token appears somewhere. Ranking: label prefix (8) > label substring (4) > group (2) = project name (2) > command body (1) = hook text (1). Score ties keep discovery order, so rows don't jump while typing. Results are capped at 50.
- Rows that have hooks carry a `hooks` chip, so a match found only in hook text is explicable rather than mysterious.
- Keyboard: `↑`/`↓` wrap-around navigation with the active row scrolled into view, `↵` reveals, `⌘↵` reveals **and runs**, `Esc` closes. Mouse hover moves the cursor; click activates (⌘-click runs).
- **Reveal** selects the owning project, switches to the command's group, scrolls the row into view, and flashes it with a blue ring for 2s. Running is never accidental — it needs the ⌘ modifier.

### Visual treatment

- Overlay: `rgba(1,4,9,.45)` plus `backdrop-filter: blur(18px) saturate(140%)` (with `-webkit-` prefix for the Wails WebKit webview) — the app behind it is genuinely blurred rather than merely dimmed.
- Panel: translucent `rgba(33,38,45,.72)` with a stronger `blur(30px) saturate(180%)`, hairline light border, 12px radius, deep drop shadow, and a short fade + rise-in animation.
- Footer shows the keyboard legend in `<kbd>` chips.

### Design note

Search remains pure functions in `frontend/src/lib/search.ts`. `searchAllProjects(projects, query, limit)` reuses the same `scoreCommand` used for single-list search, passing the project name in through the optional `project` field of `Searchable` — one scoring rule, no duplicate logic. `Searchable`'s optional `preCommands` / `postCommands` fields mirror `CommandConfig` exactly, so any command satisfies it with no adapter layer. The main command list is **not** filtered by search; it still filters by group only, so the two concerns never interact.

### Files changed

| File | Change |
|---|---|
| `frontend/src/lib/search.ts` | Pure token matching + ranking; `searchAllProjects` for global scope; `project`, `preCommands`, `postCommands` on `Searchable`; `hasHooks()` |
| `frontend/src/lib/search.test.ts` | 62 table-driven vitest cases (tokenising, scoring, per-list search, global search, hook matching) |
| `frontend/src/components/Spotlight.tsx` | New — overlay, keyboard navigation, reveal / reveal-and-run |
| `frontend/src/store.ts` | `spotlightOpen`, `searchQuery`, `highlightedCmd` (self-clearing after 2s via `setHighlightedCmd`) |
| `frontend/src/App.tsx` | `⌘K` / `⌘F` opens Spotlight; mounts it behind a `<Show>` |
| `frontend/src/components/Sidebar.tsx` | `⌕ Search ⌘K` trigger above the project list; icon-only when collapsed |
| `frontend/src/components/CommandRow.tsx` | `.revealed` flash class + scroll-into-view for the revealed row |
| `frontend/src/styles.css` | Spotlight overlay/panel/row/footer styles, sidebar trigger (plus collapsed variant), `cmd-reveal` keyframes; `#project-path` is `flex: 1` so header controls sit right |
| `frontend/vite.config.js` / `package.json` | vitest config (`node` environment) + `bun run test` |


---

## Implemented: Environments (per-project secrets)

### Goal

Let a user define any number of named environments per project (e.g. `local`, `staging`, `prod`), each holding key/value variables — typically secrets — and inject the active one into every command run.

### Where secrets live

`~/Library/Application Support/yv/environments.json`, **mode 0600**, keyed by project ID:

```json
{ "<projectId>": { "environments": [ { "id": "...", "name": "staging", "vars": [ {"key":"TOKEN","value":"…","secret":true} ] } ], "activeId": "..." } }
```

Deliberately a **separate file from `projects.json`** so that Export Project / Export Projects — and anything shared or committed — never carries secrets. Deleting a project also deletes its environments (`DeleteEnvironments`).

### Injection

`App.ExecuteCommand(cmd, workingDir, runID, projectID)` looks up the project's active environment and passes its variables to the runner, which layers them over the process environment via `env.Merge`. Order is: `os.Environ()` → login-shell `PATH` → environment variables. A variable literally named `PATH` therefore wins, which is intentional. Pre-hooks, the main command, and post-hooks all share the same resolved environment.

### UI

- **Top-right of the project header**: environment switcher showing the active environment, its variable count, and a green dot. Picking one persists immediately.
- **Manage environments…** opens a modal: environment list on the left (create / delete / mark active), variables on the right. Values are masked by default with a reveal toggle and a lock toggle per row. Nothing is persisted until Save; Cancel discards.
- **Colours**: each environment can pick a background and a text colour from preset swatches (9 backgrounds + 4 text options, first entry of each = "Default"/theme). The chosen colours tint the top-right selector, the dropdown swatches, and the modal list, so a prod environment is unmistakable. A live preview chip sits next to the pickers.
- Validation (`[A-Za-z_][A-Za-z0-9_]*`, no duplicate keys or environment names) runs in the modal for fast feedback and again in Go, which is the enforcement point.

### New Go API

| Method | Purpose |
|---|---|
| `GetEnvironments(projectID) ProjectEnvs` | Read a project's environments (values included, for editing) |
| `SaveEnvironments(projectID, ProjectEnvs) string` | Replace them; `"ok"` or `"error: …"` |
| `DeleteEnvironments(projectID) string` | Drop all environments of a project |

### Files changed

| File | Change |
|---|---|
| `internal/env/env.go` | New package — file-backed `Store` (0600) plus pure `Merge`, `ActiveVars`, `Validate`, `ValidateKey`, `ValidateColor` |
| `internal/env/env_test.go` | New — table-driven tests for merging, validation, active resolution, store round-trip, file permissions |
| `internal/models/models.go` | Added `EnvVar`, `Environment` (incl. `BgColor` / `TextColor`), `ProjectEnvs` |
| `models.go` | Wails type aliases for the three new types |
| `app.go` | `envs *env.Store`; `GetEnvironments` / `SaveEnvironments` / `DeleteEnvironments`; `ExecuteCommand` gained a `projectID` argument |
| `internal/runner/runner.go` | `ExecuteCommand` takes `[]models.EnvVar`; new `buildEnv` helper; shell runners take a resolved `environ` |
| `internal/runner/runner_test.go` | Table-driven `buildEnv` + end-to-end "variable reaches the shell" tests |
| `frontend/src/components/EnvSelector.tsx` | New — top-right switcher, tinted by the active environment's colours |
| `frontend/src/lib/envColors.ts` | New — preset palettes + pure `envChipStyle` / `swatchStyle` / `isValidColor`, shared by every environment surface |
| `frontend/src/lib/envColors.test.ts` | New — 28 table-driven vitest cases (preset integrity, colour validation, chip styles) |
| `frontend/src/components/modals/EnvironmentsModal.tsx` | New — create/edit/delete environments and variables |
| `frontend/src/store.ts` | `projectEnvs`, `envModalOpen`, `activeEnv`, `activeEnvVarCount`, `loadProjectEnvs` |
| `frontend/src/App.tsx` | Loads environments when the project changes; mounts the modal |
| `frontend/src/lib/commands.ts` | Passes `proj.id` to `ExecuteCommand` |
| `frontend/src/components/modals/ProjectSettingsModal.tsx` | Deletes environments with the project |
| `frontend/src/wails.ts` | New bindings; now typed against `types.ts` instead of the generated wailsjs classes |

### Note on `wails.ts` typing

The generated `wailsjs/go/models.ts` emits **classes** with a `convertValues()` member, so plain object literals from `types.ts` never satisfy them. The stale `import type { main }` had masked this (the namespace is `models`, not `main`, so the import silently failed type resolution). `GoApp` is now typed against `types.ts`, which already mirrors the JSON wire format — one source of truth, and `tsc --noEmit` is clean.

### Colour safety

Colours are validated as `#rgb` / `#rrggbb` (or empty) on **both** sides — `env.ValidateColor` in Go and `isValidColor` in `envColors.ts`. Since the values are written into inline `style` attributes, an unvalidated string would be a CSS-injection vector; invalid values are dropped rather than rendered, and both test suites cover an injection attempt explicitly.

### Testing

`make test` runs both suites: `make test-go` (Go, `./internal/...`) and `make test-frontend` (vitest).

---

## Implemented: Dinosaur sounds (click to roar)

### Goal

Clicking a dinosaur in the Discovery view plays a sound clip. Each dinosaur is
assigned a clip at random **once per session**, so an animal has a recognisable
voice — clicking it again replays the same clip — and a restart reshuffles the herd.

### No audio ships with the app

The clip pool is entirely user-supplied. `assets/audio/` holds development samples
only and is gitignored; nothing is embedded and `go:embed` is untouched. With an
empty pool the dinosaurs are silent, and the Discovery toolbar says so.

### Delivery: why clips go through Go

The Wails asset server serves the embedded frontend and nothing else, so a
`file://` URL from an arbitrary user directory cannot be fetched. `GetAudioClip`
reads the file in Go and returns a `data:<mime>;base64,…` URL, which the frontend
caches per path for the session — a repeat click never re-reads the disk. The cache
is cleared when the clip list changes, so a removed clip stops holding its payload.

### Assignment is a pure function, not stored state

`clipForName(name, clips, salt)` hashes the dinosaur's name (the same identity
`randomDino` keys off — there is no dinosaur id) with `SESSION_SALT`, one
`Math.random()` drawn at module load. Stable within a session, different across
sessions, and nothing to keep in sync when the pool changes. `Math.random` never
reaches the world generator, which stays seeded.

### Settings

`Settings` gains `SoundMuted bool` and `AudioClips []string`. The mute flag is
stored **inverted** because of the zero-value-means-default contract on
`models.Settings`: roars are on by default, so the field that persists is "muted".
The Settings modal grows a **Dinosaur sounds** section — a toggle plus a clip list
with `+ Add clips…` (native multi-select) and per-row removal.

Each row has a **play/pause preview**, because a filename rarely says what a roar
sounds like and there is otherwise no way to audition the pool without clicking
dinosaurs. Only one preview runs at a time; loading is async, so a monotonic
`previewTicket` decides which of two rapid clicks owns playback rather than
letting the slower load layer a second roar over the newer one. A clip that fails
to load is tagged `unplayable` on its row instead of silently doing nothing —
that is the only signal a moved or deleted file gives. `playClip` returns its
`HTMLAudioElement` (or `null`) so the modal can follow `ended`; the Discovery
caller ignores the return.

### Click feedback is independent of sound

`Dinosaur` owns a local `roaring` signal for 900ms on click, which swaps the
ambient growl loop for a single emphasised burst. It sits outside the
`prefers-reduced-motion` and `.no-motion` exemptions on purpose: like the hover
lift, it is a direct response to the pointer, not ambient motion — and it is the
only acknowledgement a click gets when sound is muted or the pool is empty.

### Also fixed

`.land-clouds` and `.land-settlements` are now `pointer-events: none`. They are
painted after the herd so they layer correctly, which meant an animal under a fog
bank was neither clickable nor nameable on hover.

### Files changed

| File | Change |
|---|---|
| `internal/audio/audio.go` | New package — `Load` (extension allowlist, 15 MB cap, data URL), `MimeType`, `NormalizePaths`, `ValidatePaths`, `DialogPattern` |
| `internal/audio/audio_test.go` | New — table-driven, incl. a base64 round-trip decode and an over-cap file |
| `internal/models/models.go` | `SoundMuted`, `AudioClips` on `Settings` |
| `internal/settings/settings.go` | `Normalize` de-dupes clips; `Validate` rejects unsupported extensions |
| `app.go` | `PickAudioClips()` (multi-select dialog), `GetAudioClip(path)` |
| `frontend/src/lib/audio.ts` | New — pure `clipForName` / `clipLabel` / `addClips` + impure `playClip` / `resetAudioCache`; `wails` is imported dynamically because it reads `window` at module scope, which would throw in the node test env |
| `frontend/src/lib/audio.test.ts` | New — 24 vitest cases (stability, reshuffle across salts, distribution, labels, de-dupe) |
| `frontend/src/components/discovery/Dinosaur.tsx` | `onSelect` prop, click handler, `roaring` burst |
| `frontend/src/components/discovery/LandscapeMap.tsx` | Forwards `onSelectDino` |
| `frontend/src/components/DiscoveryPanel.tsx` | Plays the assigned clip on click; toolbar status chip that opens Settings |
| `frontend/src/components/modals/SettingsModal.tsx` | Dinosaur sounds section |
| `frontend/src/styles.css` | `.land-dino.roaring` burst, clip list rows, `.disc-sound-status`, scenery `pointer-events: none` |
| `frontend/src/{types,wails,store}.ts` | New settings fields and bindings |
| `.gitignore` | `assets/` — samples are local-only |

---

## Implemented: Scanning drone on the discovery map

### Goal

Make the search visible on the map itself. A survey quadcopter flies a circuit over
the island: four rotors spinning, status lights **amber** while nothing has been
found and **green** once devices are there — and once they are, the circuit is re-planned to
visit them, dipping over each dinosaur as it passes.

Presentation only. No Go changes and no new peer state: `peers().length > 0` is the
entire "found" signal, and the animals to visit are just `dinos()`.

### The dip falls out of the route, not an extra animation

`dronePatrol` always returns exactly `PATROL_STOPS` (8) waypoints, and every leg
gets an equal share of the lap's time. A visited dinosaur contributes **two**
waypoints — an approach at cruise height and a lower dip just past it — so the hop
across one animal is short and therefore slow, while the long legs between animals
are covered fast. The loiter is a consequence of equal-time legs; nothing animates
it separately.

With fewer than four devices the spare slots become transit legs, placed in the
widest angular gaps around the herd so a lap stays a rough circle rather than a
shuttle back and forth over one animal. With nothing found at all, the route is a
farthest-first spread of seeded points over open ground — `openGround(world, 40)`,
the same predicate the herd uses. Unlike `randomDino` this never returns null: the
drone *is* the scanning indicator, so a world where no sampled point is acceptable
still gets a ring inside the bounds.

Once there are animals to visit the seed stops mattering — the route follows the
herd. Regenerating the world therefore doesn't move the drone for reasons the user
can't see.

### Why the travel is a script animation

The waypoints are data. A static `@keyframes` rule could only reach them through
custom properties, which pins the stop count for good and puts the route somewhere
no test can see. So `patrolFrames` / `bankFrames` emit steps and `Drone.tsx` hands
them to `element.animate()`. Per-step `easing` is what makes it settle at each
waypoint; a single easing in the animation options would apply once across the
whole lap.

The cost is that neither the `.no-motion` class nor `prefers-reduced-motion` can
cancel a script animation, so **`Drone.tsx` honours both itself** (the `motion`
prop, plus a `matchMedia` listener because the OS setting can change while the app
is open). Everything the airframe does in place — rotor spin, hover jitter, the
amber blink — is ordinary CSS and *is* in both opt-out lists. With the animation
absent the drone parks at its first waypoint, which is why the route is expressed
as offsets from a drawn `origin` rather than as absolute points.

### Geometry lives in the lib

`droneShape(drone)` returns primitives, like `dinoShape`. That is what lets a test
prove the drawing fits inside `DRONE_EXTENT` — the placement bounds are inset by it,
and the two drift apart easily. It caught the real trap: reach is set by the rotor
discs, not the airframe. A hub sits ~1.07 out along the diagonal (`ROTOR_MOUNTS`),
its disc spans 0.42 more, and the ±9° tilt swings that corner further still.

It is a **quadcopter drawn from above**, unlike the dinosaurs, which are in profile:
a rotor only reads as spinning if you are looking down the shaft, and four discs in
an X is the silhouette everyone recognises as a drone. Each arm is one rect drawn
along +x and rotated to its rotor about the shape's `origin`, rather than four
hand-placed diagonals. The four rotor periods are all different — four discs in
lockstep read as one rigid ornament.

`.land-drone` carries `pointer-events: none`. It crosses the herd, and scenery over
the herd swallowing a click is a bug this codebase has already had once.

### Files changed

| File | Change |
|---|---|
| `frontend/src/lib/drone.ts` | New — `dronePatrol`, `droneShape`, `patrolFrames`/`bankFrames`, `droneInsets`, `ROTOR_MOUNTS`, `DRONE_EXTENT` |
| `frontend/src/lib/drone.test.ts` | New — 77 seeded cases (route, dip, bounds, extent fit incl. tilt, quad layout, frames) |
| `frontend/src/components/discovery/Drone.tsx` | New — projection of `droneShape`, four nested transform layers, WAAPI patrol |
| `frontend/src/components/discovery/LandscapeMap.tsx` | `drone` / `droneLocked` / `motion` props; drawn between settlements and clouds |
| `frontend/src/components/DiscoveryPanel.tsx` | `droneBounds` + `drone` memos; passes `peers().length > 0` and `discoveryMotion()` |
| `frontend/src/lib/landscape/palette.ts` | `droneShell`, `droneShellDark`, `droneBlade`, `droneLightIdle`, `droneLightLocked` |
| `frontend/src/styles.css` | Rotor/hover/blink keyframes, light state on `.locked`, `pointer-events: none`, both motion opt-out lists |

---

## Implemented: The fleet, the burst, and the no-devices dialog

### Goal

Three things the first drone was missing:

1. **"No devices nearby" was unreadable.** It was a caption laid over the terrain,
   competing with mountains and settlement labels. It is now a dialog.
2. **A failed sweep had no ending.** The drone circled forever over an empty island.
   Now it **bursts and leaves no trace**, and the dialog takes over.
3. **One airframe.** There are now five, and the user picks which one goes out.

### The sequence

```
launch → flying (amber lights, rotor hum)
   ├─ device found  → lights green, route re-plans to visit the dinosaurs
   └─ 14s, nothing  → bursting (flash + shockwave + debris, 900ms)
                        → gone (nothing on the map at all)
                          → NoDevicesModal: pick an airframe, ↻ Send another drone
```

`droneState` lives in the **store**, not the panel: the dialog outlives a sweep, and
the airframe chosen in it has to survive the panel re-rendering around it. A device
appearing cancels everything — even mid-burst the drone comes back, because now
there is something to go and look at.

14 seconds is not a discovery timeout (mDNS answers in well under a second when
anything is there). It is how long the flight is worth watching before the app
admits there is nobody about.

The remaining time is **shown** in the peer status chip — `9s` plus a bar that
drains — because otherwise the burst happens on a schedule the user cannot see, and
"it blew up" reads very differently from "it ran out". The chip stores the *deadline*
and a 250ms ticker only decides how often it is redrawn, so the display can never
drift from the single `setTimeout` that actually ends the sweep.

With discovery itself broken the sweep still ends, but the dialog is **not** opened:
its advice (open yv on another laptop) would be wrong and another drone cannot help,
so the map's "Discovery unavailable" stands on its own.

`droneLaunch` is a counter mixed into the route seed, so a replacement drone flies a
genuinely new circuit rather than repeating the sweep that just failed.

### Why the burst needs `commitStyles`

The travel is a script animation, so cancelling it would snap the drone back to its
drawn origin and explode it there. `animation.commitStyles()` writes the current
transform to the element first, so the burst happens **where the drone actually
was**. Wrapped in try/catch — if it ever throws the burst is merely in the wrong
place, which is not worth failing over.

The burst is deliberately **exempt from both motion opt-out lists**, like the
dinosaur's roar: it is a one-off event that means something (the sweep failed), and
suppressing it would make the drone vanish between frames with no explanation.

`burstShards` is seeded from the drone's own route, so a given failed sweep always
breaks up the same way — a drawing, not a particle system, and therefore testable.
Angles are deliberately uneven: evenly spaced debris reads as a flower.

### The fleet

`DRONE_VARIANTS` — Scout (quad, 2-blade), Surveyor (quad, 4-blade), Hauler (quad,
6-blade), Hex Scout (hexa, 2-blade), Courier (hexa, 4-blade). Each carries its own
rotor count, blades per fan, reach, disc radius, body proportions and three colours.
Colours are literals in the variant rather than in `LAND` because a variant is a
*set* of them, and a set split across two files drifts.

`rotorMounts` gives a quad an X (front pair wider, so it has a nose) and a hexa six
evenly spread, offset half a step so none sits dead ahead. `bladeAngles` spaces
blades over a **half** turn — each ellipse already covers both sides of the hub, so
a 6-blade fan is three ellipses at 60°.

`droneExtent(variant)` replaced the hand-written `DRONE_EXTENT` constant. It is
derived from the variant's own mounts, disc radius and the tilt swing, which kills
the whole class of bug the constant had: five airframes with hand-maintained extents
would have been five chances to clip a rotor at the panel edge.

`DroneGlyph` was split out of `Drone` so the picker tiles draw the *same* aircraft
the map does, built through `dronePatrol` with zero-size bounds. A preview that
diverged from what gets sent would be worse than no preview.

### Sound

`Settings.DroneFanClip` — one user-chosen clip, looped while a drone is patrolling.
`Settings.DroneCrashClip` — one played once when a drone comes down. Separate
settings because they are different sounds doing different jobs: one is ambient and
looped, the other marks the end of the sweep. **No audio ships with the app**,
exactly as with the roars: empty means silent, and both the dialog and Settings say
so rather than leaving it a mystery.

**Why the hum needed a gesture.** A picked clip did not play at all. WebKit will not
start audio that no user gesture asked for — a roar is safe because it *is* a click,
but this loop starts because a drone took off, and `startClipLoop` awaits a disk read
first, so any gesture window is long gone by the time `play()` runs. Wails never sets
`mediaTypesRequiringUserActionForPlayback` and exposes no option for it, so the fix
is in the app: a refused loop is not a failure, it is **armed** — the element stays
loaded and a one-shot `pointerdown`/`keydown` listener starts it synchronously inside
the user's next click anywhere. `LoopStatus` ('playing' | 'blocked' | 'failed') is
published through `onClipLoopStatus`, and the Discovery toolbar says *which* it is:
"Click to start rotor sound" versus "Rotor clip unplayable" versus
"Silent — no drone in the air". Those three look identical from the outside, and
telling them apart is the difference between a bug report and a click.

`startClipLoop` is idempotent on the path, because its caller is an effect that
re-runs whenever anything about the drone changes — a hum that restarted from the top
every time a device appeared would stutter. It keeps a monotonic ticket, since two
starts in quick succession would otherwise both reach `play()` and layer two hums.
`resetAudioCache` deliberately does **not** stop the loop: the clip list changing is
not a reason for the drone to fall silent, and nothing would restart it.

The hum follows the Motion toggle too — a hum over stationary rotors is incoherent.

### Go side

`Settings.DroneVariant` and `Settings.DroneFanClip`, both `omitempty` with
zero-value-means-default. `ValidateDroneVariant` checks only the *shape* of the id
(lowercase slug, ≤32 chars): the fleet is a set of drawings and lives in the
frontend, so duplicating the list in Go would give two places to add a drone and one
of them would be forgotten. Unknown ids fall back via `variantById`, which is why a
renamed variant cannot ground the fleet. The fan clip answers to the same extension
allowlist as the roars (`audio.ValidatePaths`) rather than a rule of its own.

### Files changed

| File | Change |
|---|---|
| `frontend/src/lib/drone.ts` | `DRONE_VARIANTS`, `variantById`, `rotorMounts`, `bladeAngles`, `droneExtent`, `burstShards`; `droneShape` follows the variant |
| `frontend/src/lib/drone.test.ts` | 94 cases — fleet integrity, per-variant extent fit incl. tilt, quad/hexa layout, burst debris |
| `frontend/src/lib/audio.ts` | `startClipLoop` / `stopClipLoop` / `loopingClip`, `FAN_VOLUME`, `LoopStatus` + gesture-armed retry, `onClipLoopStatus` |
| `frontend/src/components/discovery/DroneGlyph.tsx` | New — the airframe alone, shared by the map and the picker |
| `frontend/src/components/discovery/Drone.tsx` | Burst state, `commitStyles` freeze, variant colours |
| `frontend/src/components/modals/NoDevicesModal.tsx` | New — the dialog, fleet picker, ↻ Send another drone |
| `frontend/src/components/DiscoveryPanel.tsx` | Sweep/burst/gone state machine, fan loop, status chip reopens the dialog, map overlay now only for a discovery failure |
| `frontend/src/components/modals/SettingsModal.tsx` | Survey drone section: airframe select + rotor and crash clips, via a local `SingleClipRow` sharing the roar pool's preview state |
| `frontend/src/store.ts` | `droneState`, `droneLaunch`, `launchDrone`, `droneVariant`, `droneFanClip`, `noDevicesOpen` |
| `internal/models/models.go`, `internal/settings/settings.go` | `DroneVariant`, `DroneFanClip`, `DroneCrashClip`, `ValidateDroneVariant` |
| `frontend/src/styles.css` | Burst keyframes, `.nodev-*` dialog and picker tiles; share-PIN row fix |

### Fixed along the way: the share-PIN row in Settings

The PIN field filled its whole row and squeezed its own label to one word per line.
`.modal-box input { width: 100% }` is a class *plus* an element, so it outranks the
lone `.settings-pin-input` class no matter what order they appear in — the retention
field escaped the same fate only because `.settings-row-control input[type="number"]`
happens to be more specific. Fixed by naming the ancestor
(`.modal-box .settings-pin-input`) and giving `.settings-row-main` `flex: 1`, so a
control that turns out wider than expected can no longer collapse the label column.

---

## Implemented: Connect by code, then send anything

### Goal

Two changes to the share flow:

1. **Connecting is its own step, gated by a code**, settled before the user
   chooses anything to send.
2. **Files can be sent**, not just config — anything on the local disk, picked
   through the native file dialog.

### The flow

```
tap a dinosaur
  -> this device draws an 8-character code and shows it large
  -> the user reads it out; the other screen says "<name> wants to connect"
  -> that person types it             -> connected (15 min)
  -> the share dialog opens: one project / everything / files
  -> they accept the transfer itself  -> it lands
```

Two prompts, deliberately. The first asks *who*, the second asks *what*, and
they are answered at different moments by different people.

### Only the hash crosses the wire

The code is generated on the **sending** side and never leaves it — the offer
carries `HashPIN(code)`. So the receiving device *cannot display it*: the only
way its user has the code is that someone told them. That is the entire
mechanism. Possession of the code is evidence that two people actually spoke,
which is precisely what a stranger on the same Wi-Fi cannot produce, however
many times they ask. `TestConnectCodeNeverReachesTheReceiverInTheClear` guards it.

It also means there is no network oracle to grind: wrong codes are typed locally
into the receiver's own dialog, not submitted over the wire, so the only limit
needed is `MaxCodeAttempts` (5) — after which the request is dropped. The dialog
counts down out loud, because a request that vanishes on the fifth try without
warning reads as a bug.

**Mandatory, with no setting.** The stored `SharePIN` is gone from Settings
entirely. A lock people can quietly leave open is one that is quietly left open,
and a per-attempt code makes the old "leave it empty" default meaningless.
`hello` therefore always reports `pinRequired: true`; the field survives only so
an older peer that answers `false` is read truthfully rather than assumed open.

### The connection is enforced, not just a screen

`conns` records who has been let in, for `ConnTTL` (15 minutes, extended by use
so a long browse for a file does not lapse mid-choice). A transfer from a peer
that never connected is answered `respNoConn` **without a prompt** — skipping the
connect step must not be a way around the decision made in it
(`TestSendWithoutConnectingIsRefused`).

### The alphabet is chosen for reading aloud

31 symbols: uppercase and digits with every homoglyph removed — no `O` or `0`,
no `I`, `L` or `1`. A transcription error surfaces only as a flat refusal with
no hint which character was wrong, so the fix belongs in the alphabet. Matching
folds case for the same reason. Drawn with `crypto/rand` by rejection sampling,
because 31 does not divide 256 and a plain modulo would make the first few
letters measurably likelier. Displayed 4 + 4: eight unbroken characters get read
back wrongly far more often.

### Files

`SharePayload` gains `Files []SharedFile`, under scope `"files"`. Config and
files never travel together, and **`applySharedPayload` branches on the payload's
scope, not on which fields happen to be populated** — otherwise a payload the
user accepted as config could still drop files on their disk.

`SharedFile.Data` is a `[]byte`, so `encoding/json` renders it as base64 and the
existing gzip'd-JSON transport carries it unchanged. No second codec, no
chunking: the stream is already framed, ordered and encrypted by libp2p, and the
bound that matters is memory, not the wire.

Caps are the memory bound: 32 MB per file, 64 MB per transfer, 64 files. The
receiver's decompression limit is derived from the sender's cap
(`maxFilePayload = MaxTotalBytes*2 + 1MB`), with a test asserting the two do not
drift — otherwise a transfer the sender was allowed to build would be refused on
arrival. Config keeps its old tight 16 MB bound; the limit and the deadline are
both chosen from the offer's scope.

### The filename is the attack surface

`SafeName` treats an inbound name as hostile, because it decides a path we are
about to write to: both separator kinds (a Windows-shaped name can reach a Mac),
the parent-directory entry, control characters and a leading dot are all
removed, and an empty result becomes a placeholder rather than a name that
resolves to the directory itself. `SaveFiles` sanitises **again** rather than
trusting its caller — it is the last step before a path is written.

An existing file is never overwritten; a collision becomes `name (2).ext`. The
receiver agreed to accept a file, not to lose one.

Files land in `~/Downloads/yv-received` because that is where every other app
puts things that arrived from elsewhere, and it is not a directory anything of
theirs depends on. The summary names the folder — a file the user cannot find is
one they did not receive. The inbound prompt **lists the filenames**, not just a
count: the name is the only thing that tells the receiver whether this is what
they were expecting.

### A refusal, a silence, and an old build are three different things

The first version of this reported all three as "they did not accept the
connection", which is worse than useless: it names a decision the other person
never made. So the protocol distinguishes them.

`respNoAnswer` is written when the prompt expires untouched, separately from
`respDecline`. The sender says "no answer yet — they have not typed the code"
rather than accusing anyone of refusing, and only one of the two is worth
retrying.

`ShareProto` moved to **1.1.0**. A build from before this change would read a
connection request as a transfer offer — it would prompt its user to accept a
payload that never arrives (this is where the phantom `the project "untitled"`
prompt came from) and answer with a PIN refusal that reads here as a decline.
Versioning the protocol makes that impossible: the stream simply cannot be
opened, `isUnsupported` recognises the negotiation failure, and the dialog says
"that device is running an older version of yv". `TestShareProtocolIsVersioned`
guards the number against a careless revert.

`decisionWait` is a field on `Node` rather than the constant inline, purely so a
test can exercise the timeout branch without waiting two minutes for it.

### Files changed

| File | Change |
|---|---|
| `internal/share/connect.go` | New — `connTable` (who is let in, `ConnTTL`), `connReq` (a pending request and its attempt count) |
| `internal/share/helpers.go` | `GeneratePIN`, `pinAlphabet`, `NormalizePIN` (case folding), `CodeMatches` |
| `internal/share/transfer.go` | `handleConnect`, `RequestConnect`, `AnswerConnect`, `DeclineConnect`, `respNoConn`/`respNoAnswer`, `isUnsupported`, scope-driven payload limits |
| `internal/share/node.go` | `ShareProto` 1.1.0, `conns`, `connPending`, `decisionWait`, scope constants; `SetPIN`/`requiredPIN`/`pinFails` removed, `hello` always requires a code |
| `internal/share/files.go` | New — `PrepareFiles`, `SafeName`, `SaveFiles`, `ReceiveDir`, `HumanSize`, size/count caps |
| `internal/share/files_test.go` | New — sanitising (incl. a stays-inside-the-directory property), caps, no-overwrite |
| `internal/share/*_test.go` | Handshake e2e, code generation/alphabet/case, conn table and attempt counting |
| `internal/models/models.go` | `SharedFile`, `SharePayload.Files`, `ShareOffer.Kind`/`FileNames`/`TotalBytes`, `OfferKindConnect`; `Settings.SharePIN` removed |
| `internal/settings/settings.go` | `ValidateSharePIN` and the PIN bounds removed |
| `app.go` | `NewConnectionCode`, `ConnectToPeer`, `AnswerConnectRequest`, `DeclineConnectRequest`, `DisconnectPeer`, `PickFilesToShare`, `InitiateFileShare`, `saveSharedFiles` |
| `app_share_test.go` | A files share must not touch config, and a config share must not write files |
| `frontend/src/components/modals/PeerConnectModal.tsx` | New — draws the code, shows it, waits |
| `frontend/src/components/modals/IncomingConnectModal.tsx` | New — types the code, counts attempts down |
| `frontend/src/components/modals/ShareModal.tsx` | PIN field gone; third scope with file picker, list and per-row removal |
| `frontend/src/components/modals/IncomingShareModal.tsx` | Names the offered files and says where they land |
| `frontend/src/components/modals/SettingsModal.tsx` | The PIN row is now an explanation, not a control |
| `frontend/src/store.ts` | `shareStage`, `openShareWith`, `pinAccepted`, `incomingConnect` |
| `frontend/src/App.tsx` | `share:connect-request` / `share:connect-closed`; mounts the inbound connect dialog globally |
| `frontend/src/styles.css` | `.connect-modal`, code typography, spinner, file list rows, three-column scope grid |

---

## Implemented: Rivers as variable-width channels, and an irregular swell

### Goal

The rivers read as **roads**: four constant-width strokes of one centreline with a
dashed `foam` line down the middle, which the eye takes for lane markings. And the
coastal swell read as a **contour map**: every ring was `insetPolygon(coast, -offset)`,
so all of them were the coastline scaled — perfectly nested curves, each parallel to
the shore and to each other.

Both defects are the same kind: a shape derived from another shape by one constant
offset. The fix in both cases is to make the offset vary.

### Width is generator data, geometry is a pure projection

`River` gains `widths: number[]`, one per point, because `buildRivers` is the only
place that knows where the tributaries join. Hydraulic geometry — width goes as
√discharge — puts the trunk's own catchment growing downstream and each tributary's
share arriving at its confluence on one scale, so the trunk is visibly fatter below
every junction. That step is the only cue that says two rivers became one.

The profile is normalised to a peak of exactly `trunkWidth` and **the peak is assigned
literally**, so `Math.max(...widths) === width` bit-exactly. `width` is the radius
`waterDiscs` reserves; had the estuary flare been able to push the maximum above it,
the reserve would have grown with the flare and the tree line would have retreated
along the whole course. `WATER_RESERVE` is now exported rather than repeated as `0.8`
in three places.

`river.ts` derives everything else and writes nothing back: `River.points` is load
bearing (a tributary's last point is by-value identical to a trunk vertex, and the
scatter passes reserve clearance around each one), so the resampled centreline lives
only at draw time.

### Two generator bugs the width profile exposed

Both were invisible while every river was one width, and both are cusps a widened
channel cannot render:

- The trunk drew `rng.range(-90, 90)` **independently per interior point**, so
  consecutive points could swing to opposite extremes — a zigzag, not a meander, and
  where the highland source sat near the chosen mouth it turned tighter than the
  channel is wide. Replaced by one coherent wave, `sin(t·π) · A · sin(t·ω·π + φ)`:
  same envelope, same amplitude budget, bounded curvature.
- A tributary's middle point bowed off the straight line by a flat ±60px. `clampInside`
  can pull a source back to within a few dozen px of the junction, and ±60px on a run
  that short doubles it back on itself. The bow is now a share of the **span**.
- `clampInside` collapsing a source onto its junction also produced tributaries a few
  dozen px long. Both signs of the offset are now tried and the longer kept: a junction
  near the shore has one side of it in the sea, and the mirrored offset points inland.

### Banks are not parallel because each side has its own wobble

A width profile is symmetric, so tapering alone leaves the two banks mirror images and
the channel still looks extruded. Each side gets its own two harmonics in normalised
arc length — `jitterRing`'s reasoning, applied along a course instead of around a ring.
Both sides stay above `1 − BANK_AMP` of the half-width, so a wobble can never pinch.

The curvature clamp is the pinch guard, and it is deliberately conservative
(`MAX_CURVE_FILL = 0.55`, taken from the **sharpest bend within one sample** and applied
to *both* banks). Curvature is estimated from samples 9px apart, so it understates a
corner sharper than that; and which side of a bend is the inner one flips with the sign
of that same estimate, which near an inflection is exactly what is least reliable.

`riverBanks` samples the **Catmull-Rom curve**, not the control polyline — a tributary
has three points, and offsetting those directly gives a bent stick with a kink at the
middle one. Hence `catmullRomPoints` in `geometry.ts`, sharing the path emitter's
neighbour clamp and its 1/6 tangent convention so the samples lie on the drawn curve.
The step adapts down on a short course (`MIN_SAMPLES`), because three samples cannot
carry a wobble, a shoal or a streak.

### The shoal slides; it does not sit inside

A narrower band on the same centreline is exactly the third stroke this replaced, and
concentric bands are what make water read as a pipe. The lit band's centre is offset by
`dot(normal, LIGHT)`, so it crosses from one bank to the other as the course turns and
vanishes where the channel runs along the light.

### A stream is described lengthwise

Short marks alone are flecks *on* water. `flowThreads` lays streamlines the length of
the channel at spread depths, each wandering slowly between depths; `flowRipples` puts
short marks over them, because a channel of nothing but parallel lines reads as combed
hair.

The two **cannot share an animation**, which is why `Streak.kind` exists. A rigid
translate is only downstream for a mark short enough to be locally straight — applied
to a thread following a bend it would push half the line out through the bank. So a
thread carries a glint *along* itself via `stroke-dashoffset` and a ripple drifts
bodily and fades. The dash offset is the one animation on the map that is neither
transform nor opacity, and it is deliberate: it was wrong for the centreline it
replaced because that was a single dash down the middle of a uniform pipe, which is a
road marking; several at different depths inside an organic channel is current.

Anything drawn inside the channel is clamped against the bank **as actually drawn**,
not against the nominal half-width — the curvature clamp can pull a bank well inside
`half`, and a shoal or streak following `half` there would spill onto the grass.

### Layered by role, not by river

`Water.tsx` makes four passes over all rivers — every casing, then every channel, then
the shoals, then the streaks. Drawn river-by-river, a tributary would lay its dark
casing straight across the trunk that was already finished and every confluence would
have a seam through it.

### The swell is broken crests, not a line around the island

An unbroken curve returning to its own start is a **boundary**: the eye follows it round
rather than across, so a closed ring reads as a racetrack marking however irregular its
shape. Each wave is therefore cut into separate open arcs (`breakIntoCrests`), the way
real swell shows — a crest rises over some stretch of shore, dies, and another picks up
further along.

The cut positions are drawn **per ring**, which is the opposite of what the shape
harmonics do, and deliberately so: the shape has to be shared or the rings cross, and the
gaps have to differ or they line up radially and punch a visible corridor through the
swell. Each crest is jittered off its ring's base width and opacity, because arcs at
equal weight and equal spacing are just a dash pattern — the thing being avoided.

A crest is **dropped entirely** where its shore is sheltered. Drawing the lee closer in
or fainter is not enough: distance and opacity both still say "wave, over there", whereas
no arc says there is no wave there, which is what shelter means.

One consequence worth knowing: the wave's own opacity belongs to the animation.
`land-wave-break` fades the whole group 0 → 1 → 0, so a crest's value multiplies with
that. While a wave was a single path the keyframe simply overrode its `opacity`
attribute, which is why the numbers in `coastalSwell` had no effect at all and had to be
raised when the arcs became children of an animated group.

Underneath that, each ring's offshore distance varies along the shore with harmonics in
the bearing around the island, and:

- **The rings share their harmonics** and differ only by a small phase march. Drawing
  each independently made them cross, which reads as scribble; one shape advancing
  along the shore reads as a swell.
- **The wobble scales with how far offshore the ring is.** Waves refract as they shoal,
  so a breaking wave lies along the beach whatever shape it had at sea. That is also
  why the bands never pile into each other at the point where they are closest.
- **Swell comes from a direction.** One bearing per island; exposure remaps
  `dot(outward, swell)` into `[LEE_FLOOR, 1]`, so the bands crowd one flank and thin
  out around the back. An equal band off every side is a ripple in a pond.

`Wave.reach` (the mean distance a ring actually stands off) is now separate from
`Wave.offset` (its nominal station), because the wobble and the lee move a ring off its
station and `to` must scale from where it really is — otherwise the bands cross on the
way in.

### Lakes

The highlight ellipse was centred on the basin, the one feature on the map ignoring the
top-left light. It is now offset toward the light, over a new inner shadow on the far
rim — the shadow is what actually reads as depth; without it the highlight is a sticker.

### Files changed

| File | Change |
|---|---|
| `frontend/src/lib/landscape/geometry.ts` | `catmullRomPoints`, `resample`/`Sampled`, `sampleScalar`, `tangents`, `normal`, `curvatures` |
| `frontend/src/lib/landscape/world.ts` | `River.widths`; coherent trunk meander; span-proportional tributary bow; both-signs source pick; three-pass `buildRivers`; exported `WATER_RESERVE`; `buildLakes` comment corrected to "headwater tarns" |
| `frontend/src/lib/landscape/river.ts` | New — `riverBanks`, `shoalPath`, `flowThreads`/`flowRipples`/`flowStreaks`, `riverRibbon`, `riverSeed`, `bankPad`, `widestDrawn` |
| `frontend/src/lib/landscape/river.test.ts` | New — no-fold proof, drawn-inside-the-reserve non-regression, containment, degenerate courses |
| `frontend/src/lib/landscape/sea.ts` | Per-vertex reach with shared harmonics, phase march, refraction taper, directional exposure; `Wave.reach`; `breakIntoCrests` and `Wave.arcs` replacing the single closed `d` |
| `frontend/src/lib/landscape/sea.test.ts` | Not-a-traced-coastline, broken-crests, varied-weights, sheltered-stretch and staggered-seam invariants; break line measured from `reach`; containment by bearing rather than index pairing |
| `frontend/src/components/discovery/LandscapeMap.tsx` | A wave is an animated `<g>` of crest paths — the crests must come in together |
| `frontend/src/lib/landscape/{geometry,world}.test.ts` | Helper tests; width-profile and confluence-step invariants; ribbon paths added to the NaN sweep |
| `frontend/src/components/discovery/Water.tsx` | Four role passes over filled ribbons; two streak classes; lake shadow + lit highlight |
| `frontend/src/styles.css` | `land-flow`, `land-flow-march`, `land-shoal-breathe`; `.land-river-thread`/`-streak`/`-shoal` added to all three motion opt-out lists; `land-glint` and `.land-river-glint` removed |

---

## Implemented: Surf, whitecaps and a sea surface

### Goal

Match the sea of a stylised isometric reference: white surf collaring the shore,
whitecaps scattered over the water, and a surface made of flat tone areas.

The swell rings already answered *which way the water is going*. What the map still
lacked was any answer to *is this water at all* — outside the crests it was a dark
gradient, and a gradient has no surface, so the sea read as empty space with a few
pale scratches on it. Three additions, all in the existing dark palette rather than
the reference's turquoise (the palette decision from the river pass stands).

### Surf is a band, not a stroke

`coastalSurf` returns a filled annulus — outer edge forwards, shoreline reversed, in
one subpath — because the two edges do different things: the inner one is the
shoreline exactly, the outer one scallops in and out. A stroke can only ever be the
shoreline offset by one number, which is the same defect the swell rings had. The
scalloped inner edge is the single strongest cue in the reference; a constant-width
white ring is a sticker, not spray. The lobes never pinch fully off, because a gap in
the collar reads as a hole in the island.

`LAND.surf` is a new near-white. The existing `foam` is a pale blue — right for a
glint on a river, but at the shore it reads as haze, and surf is white.

### Whitecaps are rejection-sampled, and tested for it

`whitecaps` scatters short crescents over open water, kept within `CAP_MAX_OFFSHORE`
of the shore so they describe water *around the island* rather than confetti to the
frame edges — the far corners of the reference are bare.

The bug worth remembering: rejecting on the sample point alone is not enough. A cap is
a stroke up to 19px each way, so a centre that clears the shore by less than that puts
an end of the stroke on the grass. **The drawn ends are tested against the coast and
the islets**, which is exact, where a margin on "distance to nearest coast vertex"
would not be — that distance overstates the distance to the coastline between
vertices, and the island is a blob, so no single radius is safe everywhere.

Shape matters more than count here, and both extremes were wrong on the way: long thin
near-straight marks read as scratches on the picture, and bowing one as hard as it is
long turns it into a bracket. A shallow crescent, short and thick, is a crest.

They lie roughly along the shore's bearing with jitter. All at one angle reads as
hatching; fully random reads as scratches.

### The surface is flat patches, and does not move

`seaPatches` lays broad `jitterRing` blobs of slightly different tone under
everything. This is what makes water read as a *surface seen from above* rather than a
lit volume. Deliberately motionless — it is the water's colour, and drifting it would
make the whole sea slide. `SeaPatch.tone` is an index rather than a colour, so the
palette stays the one place the map's colours live.

### Animation

`land-cap-crest` peaks at `var(--cap-peak)`, the cap's *own* opacity, not at 1 — a
keyframe ending at 1 would flatten every cap to the same brightness at exactly the
moment they are most visible, throwing away the seeded variation. `land-surf-breathe`
swells and eases without ever going out, because the shore is always breaking; it
scales about the map's origin (`transform-box: view-box`) rather than its own bounding
box, which would walk the collar off the shore on one side.

Both are in all three motion opt-out lists. No animation library: everything here is
opacity and transform, which CSS keyframes already do, and a script animation would
sit outside those lists — the problem `Drone.tsx` has to handle by hand.

### Files changed

| File | Change |
|---|---|
| `frontend/src/lib/landscape/palette.ts` | `seaTeal`, `seaTealLight`, `seaGreen`, `surf` |
| `frontend/src/lib/landscape/sea.ts` | `coastalSurf`, `whitecaps`, `seaPatches` and their types/constants |
| `frontend/src/lib/landscape/sea.test.ts` | Band-not-stroke, scalloped-edge, never-on-land, near-the-island, stable-per-seed |
| `frontend/src/components/discovery/LandscapeMap.tsx` | Patches under the swells, caps and collar above the crests |
| `frontend/src/styles.css` | `land-cap-crest`, `land-surf-breathe`; `.land-cap`/`.land-surf` in all three opt-out lists |

---

## Implemented: An optional username

### Goal

Let the user say what nearby devices call this one. Until now the only answer was
the hostname, so a room full of Macs introduced themselves as `Rexy.local` and
`MacBook-Pro-3` — names their owners did not choose and cannot be recognised by.

### Optional means the hostname, not a blank

The zero value has to mean the default, like every other field on
`models.Settings`, so an empty username is not "a device with no name" — it is the
hostname. `Node.SetLocalName` does that fallback itself rather than trusting the
caller: a blank name would strand the peer on a short peer ID at the far end,
which is the one outcome worse than a hostname.

It is trimmed but **not** run through `NormalizeName`. That helper strips a
`.local` suffix, which is right for a name the OS reported and wrong for one a
person typed.

### The name is an identity, not a caption

It seeds the peer's dinosaur and the roar it is given on the other end's map, so
changing it changes the animal other people see. That is the point of having it.

Control characters are stripped and whitespace runs collapse in
`NormalizeUsername`, because the value is drawn on someone else's screen. Length
is bounded in **runes**: bounding bytes would cut a name of emoji or CJK at a
third of the characters the user can see. The frontend deliberately has no
`maxlength` for the same reason — that attribute counts UTF-16 units, so it would
stop at half the characters `validate()` and Go both allow.

### It follows the setting while running

`app.go` registers a `set.OnChange` observer, so renaming yourself mid-session
does not need a restart. A hello is served per discovery, so the next one carries
the new name; peers who already have you on screen keep the old one until they
rediscover you, which is the honest reading — that is the name they were told.

`localName` is guarded by its own `nameMu` rather than the peer-table mutex: it is
written from the settings observer while a hello may be being served, and serving
one must not wait on the peer table.

`GetDefaultDeviceName` exposes the hostname so Settings can show it as the
placeholder — otherwise the default is something the user can only learn by asking
a colleague what their screen says.

### Files changed

| File | Change |
|---|---|
| `internal/models/models.go` | `Settings.Username` (`omitempty`) |
| `internal/settings/settings.go` | `NormalizeUsername`, `ValidateUsername`, `MaxUsernameLen`; wired into `Normalize`/`Validate` |
| `internal/settings/settings_test.go` | Normalising, rune-counted bounds, store round-trip incl. clearing |
| `internal/share/node.go` | `nameMu`, `SetLocalName`, `LocalName()`; `handleHello` reads it live |
| `internal/share/share_test.go` | `TestSetLocalName` — trimming, dotted suffix kept, empty falls back |
| `app.go` | Seeds the share name from settings and follows it via `OnChange`; `GetDefaultDeviceName` |
| `frontend/src/components/modals/SettingsModal.tsx` | "Your name" row in the Sharing section, hostname placeholder, rune-counted validation |
| `frontend/src/{types,wails}.ts` | `AppSettings.username`, `GetDefaultDeviceName` binding |
| `frontend/src/styles.css` | `.modal-box .settings-username-input` — ancestor named for the same specificity reason as the old PIN field |


---

## Implemented: Files get their own transport, up to 500 MB

### Goal

Raise the file-sharing limit from 32 MB to 500 MB. Bumping the constant alone
would have been a trap, so the transport changed instead.

### Why the number was not the problem

File bytes rode the config payload: `os.ReadFile` into a `[]byte`, base64'd into
JSON by `encoding/json`, gzip'd, and decoded the same way on the far side. A
500 MB file needs **~1.2 GB of RAM per machine** that way — 500 MB read plus
~667 MB of base64 in the encoder's buffer, mirrored on decode. The 32 MB cap was
not a policy about what is worth sending; it was the memory ceiling.

Streaming makes the size irrelevant: **one 32 KB buffer per side**, whatever the
file.

### Two transports, one gate

`ShareProto` `/yv/share/1.1.0` is **untouched** — connection requests and config.
`FileProto` `/yv/files/1.0.0` is new and purely additive.

A second protocol rather than a version bump, because that is what lets a peer
missing one still use the other: `isUnsupported` turns the failed negotiation
into "that device is running an older version of yv" **for file shares only**,
while config keeps working across the skew.
`TestOldPeerKeepsConfigButNotFiles` is the guard on exactly that.

What both share is `gate()` — the connection check, the identity resolution, the
user's prompt and the response byte — extracted from `handleShare` so "a peer we
have not connected to gets nothing" has one implementation rather than two that
drift. `readOffer` and `gate` are the seam; only the body differs. No interface:
libp2p already dispatches on the protocol id, and each protocol has exactly one
implementation, so an interface would add indirection with nothing to substitute.

### The body is opaque, and that is what the framing has to guarantee

Only a ~60 byte header per file is structured:

```
{"name":"app-release.apk","size":52428800}\n   <- the one JSON line
<exactly 52428800 bytes, copied verbatim>      <- never parsed, never scanned
```

then `CloseWrite`; EOF is the terminator, so there is no count on the wire to
disagree with what arrived.

**The length prefix is what makes arbitrary binary safe.** The reader copies
exactly `size` bytes and never looks *inside* a body for anything, so a `.zip`
containing newlines, `}`, null bytes or an entire JSON document is just bytes.
A delimiter-framed format would have to escape the payload — which is precisely
the base64 tax being removed. `TestStreamCarriesAdversarialBodies` and
`TestFramingSurvivesABodyThatLooksLikeAHeader` hold that line: the second plants
a valid-looking header *inside* a file and asserts that exactly two files land
and no third is conjured from the contents.

No gzip here — `.apk`, `.zip`, `.mp4` are already compressed, so deflating them
again burns CPU on 500 MB to save nothing. Config keeps gzip; it is text.

### Deadlines bound silence, not duration

A fixed timeout cannot suit both 1 MB and 1 GB. `touchReader`/`touchWriter` push
the stream deadline forward on every chunk, so the bound is 60s of *no progress*.
A stalled peer still dies; a slow one is left alone.

### What the receiver refuses, and when

- **Not connected** → `respNoConn`, no prompt. Same gate as config.
- **Will not fit** → `respNoSpace`, **before** the prompt. Asking someone to
  accept a transfer that cannot land is worse than refusing it for them; the
  sender is told it is the other device's disk. An unmeasurable filesystem
  counts as room enough, since refusing because we could not look would block
  transfers that would have worked.
- Files land via `name.part`, renamed only once the last promised byte arrives,
  so an interruption never leaves something that looks complete.
- Written `0644` — no execute bit, whatever the extension — and never run.
  On macOS they get the `com.apple.quarantine` xattr, so a `.dmg` or `.pkg` from
  another laptop faces the same Gatekeeper check as a browser download.

### Limits

500 MB per file, 1 GB per transfer, 64 files. `StatFiles` enforces all three from
metadata **before reading anything**, so a transfer refused for size costs no
disk reads. Config keeps its own 16 MB bound.

### Progress

`share:progress` from both ends, throttled to 250 ms — at 32 KB a chunk, a
500 MB transfer would otherwise emit ~16,000 events nobody can see. The Send
button switches from "Waiting for them to accept…" to "Sending…" once bytes are
moving, because the first is untrue by then.

### Net simplification

`SharedFile`, `SharePayload.Files`, `maxFilePayload`, `filePayloadTimeout`,
`payloadLimit` and `payloadDeadline` are all **deleted**. The config path no
longer switches limits on scope, and `applySharedPayload` no longer branches on
it — files cannot reach that function at all, because there is no longer a field
on `SharePayload` for one to hide in.

### Files changed

| File | Change |
|---|---|
| `internal/share/files.go` | `PrepareFiles`/`SaveFiles` → `StatFiles`, `WriteFiles`, `ReadFiles`, `copyChunks`, `readLine`; `SafeName`/`uniquePath`/`ReceiveDir`/`HumanSize` unchanged |
| `internal/share/fileproto.go` | New — `FileProto`, `SendFiles`, `handleFiles`, `spaceCheck`, `progressReporter`, `touchReader`/`touchWriter` |
| `internal/share/transfer.go` | `readOffer` + `gate` extracted; `respNoSpace`, `ErrNoSpace`; scope-switched limits deleted |
| `internal/share/node.go` | Registers `FileProto`; `onFiles` sink, `SetFileSink`, `EventProgress` |
| `internal/share/{quarantine,freespace}_*.go` | New — build-tagged, following `app_fullscreen_*.go` |
| `internal/models/models.go` | `SharedFile` and `SharePayload.Files` removed |
| `app.go` | `InitiateFileShare` stats then streams; `receiveSharedFiles` drains to disk |
| `frontend/src/components/modals/{Share,IncomingShare}Modal.tsx` | Progress bar; limits reworded |
| `frontend/src/{App,store,types}.ts` | `share:progress`, `sendProgress`/`recvProgress` |
| `frontend/src/styles.css` | `.share-progress` |

### Follow-up: the dialogs wait to be dismissed

Both transfer dialogs closed themselves on a timer — 1.6s on the sender, 10s on
the receiver. That was tolerable when a transfer was 40 KB of config and over
before you looked up. It is wrong for a file transfer that takes a minute: the
receiver's summary is the only place the destination folder is named, and a
message that vanishes on its own takes it away from anyone who was not watching.

Both timers are gone. Each dialog now ends on a **Done** button, and the
receiver's success screen carries a **Show downloaded folder** button —
`ShowReceivedFiles` creates the folder if it does not exist yet, so it cannot
fail with "no such directory" on a device that has been sent nothing. A failure
says so inline, since the path is on screen directly above.

The opener is platform-specific (`openfolder_*.go`). The first attempt used a
`file://` URL through the Wails runtime, which looked tidier — but that runtime
validates the scheme and refuses anything but http(s), so on Linux it answered
`invalid schema not allowed` and opened nothing. macOS gets `open`; Linux tries
`xdg-open`, then `gio open`, then `nautilus`, because a minimal install can lack
xdg-utils while still having GLib — which is present regardless, since the app
itself is GTK. The path goes as an argument rather than through a shell, so
spaces and quotes in a home directory are not special.

**The exit status is waited for, not just the launch.** The first version checked
only that the process started, which proves the binary exists and nothing more:
`open` returns 1 for a path it will not handle (measured at ~6ms), so a genuine
failure was being reported as success and the button appeared to do nothing with
no explanation. `runOpener` waits, bounded by `openerTimeout` — an opener still
running after 5s has handed off and is waiting on something that is not ours to
wait for, so that counts as success. On Linux a non-zero exit also moves on to
the next candidate, since xdg-open is often installed but misconfigured, which
fails rather than refusing to start.

The dialog now shows *why* it failed rather than a fixed sentence. "Could not
open the folder" reads the same whether the file manager is missing, the path is
wrong, or the running app predates the binding — and only the last of those is
fixed by restarting.

Removing the timers exposed two things they had been covering:

- **A failed inbound transfer had nowhere to report.** `share:error` is emitted
  by both ends, and the receiver's handler was setting the *outbound* error
  state — on a machine with no outbound dialog open, that went nowhere, and the
  prompt would have sat on "Receiving…" forever. It now routes to a new
  `incomingError` when `incomingBusy()`, with its own screen and a Close button.
  Separate from `incomingResult` because that one renders with a tick.
- **Escape still meant "decline"** after the transfer had already happened.
  It now dismisses once there is a result, since there is nothing left to refuse.

`.share-done` gained `overflow-wrap: anywhere` — it now carries a filesystem
path, and a deep home directory has no spaces to break on.

### Fixed: a large transfer outlived the peer it was talking to

On Linux, a big file share died part way through. The transfer was not the
problem — discovery was.

Peer liveness was inferred from two things, and a long transfer defeats both.
`sweep` reaps anything not re-announced by mDNS within `PeerTTL` (5 minutes),
which a gigabyte over Wi-Fi comfortably outlasts; and `probe` confirms a dropped
connection with a 4-second dial, which is exactly what a link saturated by the
transfer is worst at answering. Either one calls `forget`, which emits
`peer:lost`, and `App.tsx` cleared `sharePeer` on that — unmounting the dialog
while the bytes were still moving.

**An open stream is better evidence a device is there than a missing multicast
packet is that it is not.** `beginTransfer`/`transferring` count in-flight
exchanges per peer; `sweep` skips those peers (and refreshes `lastSeen`, so one
does not expire the instant its transfer ends) and `probe` returns without
dialling. Every path that holds a stream is wrapped: both `Send` and `SendFiles`,
`RequestConnect` — a peer must not be reaped while its user is being asked for a
code — and both inbound handlers, from `readOffer` onward.

The counter is nested rather than a boolean, because sending config while
receiving files is a real pairing and the first to finish must not clear the
flag for the other.

The frontend keeps a backstop: `peer:lost` no longer clears `sharePeer` while
`shareBusy()`. The transfer reports its own errors, and pulling the dialog would
hide whichever one it was about to give.


---

## Removed: the dev-only sample dashboard data

The "Load sample data" button, the checked-in three-month spec, and the seeder
behind them are gone.

It never affected a release build — `app_nodev.go` was the production stub, so
`SampleDataAvailable()` returned false and the button was hidden — but it was a
whole feature's worth of surface (an embedded fixture, a build tag, a generator,
three tests validating the fixture) earning its keep only during development,
and the dashboard now has real metrics to render.

Deleted: `testdata/dashboard-sample-3months.json`, `app_dev.go`, `app_nodev.go`,
`internal/metrics/sample.go` and its test (`ExpandSample`, `ImportSample` and
`SampleSpec` had no other callers — checked before removing), the two Wails
bindings, the button and its `.dash-sample` styling.

The `yvdev` build tag went with it, since `app_dev.go` was the only thing it
compiled. `make run` and `make run-linux` no longer pass it, and `build-dev` —
which existed purely to package a binary that could seed sample data — is gone.
`LINUX_TAGS` stays: `webkit2_41` is a real platform tag and unrelated.

## Fixed: the activity heatmap left most of the card empty

Cells were a fixed 11px, so 53 weeks came to ~740px inside a full-width panel —
about 600px of dead space to the right of the year.

Everything is fractional now: weeks are `flex: 1 1 0`, cells stay square through
`aspect-ratio`, and the year stretches to fill the card. Two alignments had to
follow, and both would have drifted silently otherwise:

- **Weekday labels** were on fixed 11px rows. They are now `repeat(7, 1fr)` in a
  column stretched to the grid's height, so they track whatever the cells become.
- **Month labels** are placed by week index, so the label grid takes its column
  count from `grid().weeks.length`, with `minmax(9px, 1fr)` mirroring the weeks'
  own floor — that way they stay aligned when a narrow window scrolls the grid
  instead of shrinking it.

`min-width` on a week is what makes a narrow window scroll rather than squash the
year into slivers. The legend swatches are pinned to 11px explicitly, since they
sit outside the grid and would otherwise inherit the stretched size.

Two invariants the CSS now depends on, and which are invisible from the
stylesheet, are asserted in `heatmap.test.ts`: every month label's column falls
inside the week range, and every week is padded to seven rows.

### The ramp runs pale → deep

Levels 1–4 were the other way round: a busy day came out pale and a quiet one
deep. Reversed, so busier is darker — the ink-on-paper reading, where a heavy
day is a heavy mark. That is the opposite direction to GitHub's, whose ramp
brightens with activity because it is tuned for a light background.

The cost of darkening rather than brightening on a dark card is that the busiest
level moves *towards* the empty one. It still clears it comfortably — luminance
72 against 42, a 1.7x gap — and `heatmap.test.ts` now asserts both the direction
(monotonically darkening) and that headroom, because a reversed ramp looks
plausible at a glance and nothing else would catch it flipping back.

---

## Implemented: Auto-update (macOS · Windows · Linux)

### Goal

An installed copy could not learn that a newer one existed, and worse, **the
running binary did not know its own version** — `wails.json` carried a
placeholder `1.0.0`, nothing injected it, and no git tag existed. So a user who
installed six months ago had no signal at all.

### Versioning is changesets, and the number lives in two files

There is no root `package.json` in this repo's history; one was added purely as
the changesets anchor (`{"name":"yv","private":true}`), deliberately **not** a
workspace, so `frontend/package.json` and the verified `bun install
--frozen-lockfile` step are untouched.

`wails.json` stays the build's source of truth — `package-deb.sh` sed-parses
`productVersion`, and the Makefile and CI read it — so `bun run version` is
`changeset version && node scripts/sync-version.mjs`. That script rewrites the one
value with a regex rather than round-tripping the JSON, which would reformat the
file and make every release a diff touching every line.

`version_test.go` fails if the two files disagree. Drift ships a `.deb` whose
package version disagrees with the binary inside it, and the updater then compares
the wrong number — invisible until an update refuses to install.

**The `v` prefix is the trap.** `${GITHUB_REF#refs/tags/}` yields `v0.1.0` and
artifact names embed that; a *second* CI output carries the stripped `0.1.0` for
ldflags, and `CanonicalVersion` strips it at the Go boundary. Non-tag builds are
linked as `dev`, which is the updater's own short-circuit — a `main` build can
never offer to update itself into a release.

### The feed is the releases API, and the newest *version* wins

No manifest, no appcast: the API already carries the tag, notes, asset names,
sizes and URLs, and a hand-maintained manifest is a second thing to publish and a
second thing to get out of step. The feed is ordered by publish date, so every
entry is compared rather than trusting position — a patch backported to an old
branch and published late arrives first.

Assets match on the **whole platform token**, not the extension. A release with
both an arm64 and an amd64 DMG would otherwise be a coin toss, and the wrong
architecture produces a bundle that will not launch with no clue why.

Both sidecars are fetched during the *check*, so a `Release` handed onward is
already complete: there is no path where 40 MB is pulled and only then discovers
it cannot be verified. The status-code guard on a sidecar is load bearing —
without it a 404 page's first word becomes the "hash", and the failure surfaces
later as a checksum mismatch, reading as a corrupted download rather than as a
release that was never published properly.

### Signing: one scheme, two callers

RSA-4096 PKCS#1 v1.5 over SHA-256, matching the hot-updater bundle scheme so one
key-generation recipe covers both. `internal/updatesign` is imported by *both* the
signer (`cmd/sign-artifact`, CI-side) and the verifier (`internal/updater`),
because two independent implementations of "what gets signed" eventually disagree
— and the failure mode is every update refused as tampered with nothing looking
wrong.

`SigningDigest` is the reason that matters: the signature covers the SHA-256 of
the **32 decoded bytes** of the artifact's hash, not its 64-character hex
spelling. Sign the string instead and the signatures verify perfectly against
themselves and against nothing the Node tooling produces.

The public key is compiled in (`updatePublicKeyPEM`), empty until `make
update-keys` runs, and every verification then fails with `ErrNoTrustedKey` —
distinct from a bad signature, because one sends you to the build and the other to
the release. Parsing is deferred rather than done in an `init` so a malformed key
is an update failure with a message, not a binary that will not start.

**Two things are unrecoverable and are in RELEASING.md:** losing the private key
means no installed copy can ever be updated again, and rotating it takes two
releases in order (ship the new public key *before* signing with the new private
key).

### Verification is not a step a caller can forget

`Download` streams to a `.part` while hashing, and renames into place only once
checksum, size and signature have all passed. Every rejection removes the file — a
refused artifact left on disk is one the pending-download path could later pick
up. A stale `.part` is discarded rather than resumed: resuming trusts a prefix
that was never verified.

### Applying, per platform

**macOS** (`apply_darwin.go`) is the hard one. `InstallCheck` runs *before* the
download because all three refusals are permanent for the launch. The mount point
is **explicit**: the default derives from the volume name, so a "yv" volume already
mounted — exactly how the user installed it — makes macOS mount at `/Volumes/yv 1`
and the bundle gets copied from whichever the guess named. The plain-output
fallback splits on **tabs**, since whitespace truncates `/Volumes/yv 1` to a path
that probably exists and is a different volume. Staging sits beside the app so the
final move is a same-filesystem rename; across devices it silently becomes a copy.
The old bundle is moved aside, not deleted, so a failure at the last step can put
it back. `Relaunch` waits for this process to exit before `open`, because `open`
on a running bundle activates the *old* instance and then quits it.

**Windows** (`apply_windows.go`): a running `.exe` cannot be deleted but can be
renamed. Unpack fully first, rename the exe aside, copy over, each displaced file
moved into a backup so a partial copy unwinds. Files the update does not carry are
left alone — an update is not a reinstall.

**Linux** (`apply_linux.go`) is a question of *which install*: `APPIMAGE`'s
presence is the entire test, because nothing else distinguishes an AppImage from a
tarball. The `.deb` and tarball are told to use their package manager rather than
offered a download that cannot apply.

`archive.go` has **no build tag** on purpose: behind `windows` the zip-slip guard
would be the highest-risk function in the updater and the only one a macOS
developer could never execute. Its root comparison includes a trailing separator —
without it, an entry resolving to `…/staged-evil` passes a prefix test against
`…/staged`.

### UI

One `update:state` struct covers every stage; partial payloads would make the
dialog keep its own copy of the last one, which is how a progress bar outlives its
download. `publishUpdate` **records before it emits**, because the startup check
fires into a window with no dialog mounted. The listener lives in `App.tsx` for the
same reason the share listeners do.

The startup check is **silent about everything the user did not ask about** — an
alert saying "you are up to date" four seconds after every launch is the fastest
way to get the feature turned off. Pressing the button reports everything.

Release notes are markdown (changesets writes markdown), so `formatReleaseNotes`
strips the handful of markers rather than pulling in a renderer — a dependency and
an HTML-injection surface for network text, to display two headings and a list.

### CI: strictly additive

`build.yml` was verified working on macOS and Ubuntu, so the change is insertion,
not rewriting. **Exactly two lines were modified**: the two `wails build`
invocations, each gaining `-ldflags`. Artifact names are byte-identical.
Code-signing steps exist but sit behind a `workflow_dispatch` input defaulting to
false — the certificates are 1–2 months away, and their arrival should be a
secrets change, not a redesign.

`TestAssetNamesMatchWhatCIUploads` pins the naming with **literal** names. The
packaging steps and `platformToken` cannot see each other, and drift means a
release that builds and publishes perfectly and offers an update to nobody. A test
that derives the name from `platformToken` and matches it with `platformToken`
proves only that the function agrees with itself.

### Files changed

| File | Change |
|---|---|
| `package.json`, `.changeset/`, `scripts/sync-version.mjs`, `version_test.go` | changesets anchor, sync into `wails.json`, drift test |
| `.github/workflows/release.yml` | New — version PR and tag push |
| `internal/updater/semver.go` | Hand-rolled semver precedence |
| `internal/updater/updater.go` | Releases feed, asset and sidecar resolution |
| `internal/updater/signature.go` | Compiled-in public key, `HasTrustedKey` |
| `internal/updater/download.go` | Streaming download, mandatory verify gate |
| `internal/updater/apply_{darwin,windows,linux,other}.go` | Per-platform install |
| `internal/updater/archive.go` | Untagged, so the zip-slip guard is testable here |
| `internal/updatesign/`, `cmd/sign-artifact/` | The signing scheme and CI tool |
| `app_update.go`, `models.go`, `menu.go`, `main.go` | Bindings, event, menu item, quit guard |
| `frontend/src/components/modals/UpdateModal.tsx` | The dialog |
| `frontend/src/lib/releaseNotes.ts` | Markdown stripping |
| `build/linux/package-appimage.sh`, `Makefile` | AppImage packaging, `make update-keys` |
| `RELEASING.md` | The two unrecoverable facts, and the release flow |

### Not yet verified

The Windows apply path compiles and its portable half is tested, but **it has not
been executed** — there is no Windows machine or Wine here. The AppImage recipe was
built and run in a container on **arm64**; Docker's amd64 emulation on Apple
Silicon cannot exec appimagetool's static-pie binary, so the x86_64 tool download
is unproven. Dispatch the branch before tagging.

---

## Implemented: The launch splash — a cyberpunk boar

### Goal

Launching showed a blank white window. Three separate causes, none of which a
component could have fixed on its own: `main.go` set no `BackgroundColour`, so
the native window was the platform default until the webview painted;
`index.html` had no inline style, so the page was white until `styles.css`
loaded; and `App.tsx` rendered the full chrome immediately against an empty
project list, which then popped when `LoadProjects` resolved.

The first two are one line each and are what actually kill the flash. The boar is
what fills the two and a half seconds that follow.

### Fixed, not gated on boot

`SPLASH.total` is 2500ms whatever the machine does. Waiting for `LoadProjects`
would make the app's first impression a different length every launch, and on a
warm start it would be a flash rather than anything anyone could look at. Boot
runs underneath the whole time, so the splash costs only its own duration.

In dev it plays **once per session** — `wails dev` hot-reloads on every save, and
2.5s in front of each of them makes the app unusable to work on. The flag is
seeded into `splashDone`'s initial value rather than checked in the component, so
there is no frame where the splash exists and then removes itself.

### anime.js, and what it is actually for

`svg.createDrawable` is the reason for the dependency: the wireframe drawing
itself on, stroke by stroke, in `boarStrokes` order. `createDrawable(paths, 0, 0)`
— the two zeros matter, or the finished boar paints for one frame before the
timeline takes over and it reads as a flicker.

The order **is** the reveal: silhouette → creases → mane → tusks → eye, and it is
pinned in `boar.test.ts` because reordering the arrays in `boar.ts` is a one-line
change that would silently ruin the only timing the splash has. The strokes
overlap by `drawStagger`, so the test computes the end of the *last* one —
asserting `drawStart + drawDur` would pass while most of the animal was still
arriving after the glitch had already hit it.

### One drawing, three times on screen

The chroma ghosts and the glitch slices are `<use>` of the same `#boar-art`
group, not copies of the geometry. A copy would need its own animation and would
drift by however much the two disagreed; a `<use>` cannot. Their colour comes
from an `feColorMatrix` that keeps two channels and drops the third — which is
what chromatic aberration physically is — rather than from a second palette to
keep in step with the first.

Their offsets live in SVG `x` attributes, **not** in a `transform`: anime.js
animates transforms through the CSS property, which overrides the attribute
entirely, and the ghosts would snap back onto the original the moment the glitch
beat started.

### Why the field is CSS and the boar is not

Scanlines, the perspective grid and the power-on sweep are `repeating-linear-
gradient` plus keyframes — one declaration where the grid would otherwise be
sixty rects, and, unlike a script animation, cancelled by the reduced-motion
block without anything having to remember to check.

The timeline is the opposite case and inherits the trap `Drone.tsx` documents:
neither `prefers-reduced-motion` nor a `.no-motion` class can touch a script
animation. `Splash.tsx` honours it by hand — with the preference set there is no
timeline at all, the markup is already at its final state, and it holds and
fades. `.no-motion` is deliberately untouched: that toggle is scoped to
`.landscape-stage` and is about the discovery map, not app boot.

### Side view, and why the body had to go

The drawing is a boar's head and neck in **profile**, facing left, built on one
idea: in profile a boar is a **wedge**. The snout tip is the lowest,
furthest-forward point and the line runs up and back from there to a shoulder
hump. Get that slope wrong and no amount of detail rescues it.

A head-and-shoulders version was tried and abandoned. Extending past the neck
gives one long unbroken taper from snout to flank, with no jaw to break it —
which is a **whale**, the same silhouette this file failed into on its very
first attempt, reached from the opposite direction. The neck is cut off behind
the shoulder instead.

`mirrorPath` and `CENTRE_X` were **deleted** with the frontal version. A profile
has no symmetry to exploit, so they became dead code with dead tests attached;
they are in git history if a frontal view ever comes back.

### Drawing an animal is a thing you have to look at

Four passes were thrown away, and no test caught any of them — all four rendered
cleanly, stayed inside the viewBox and satisfied every invariant.

- **Whale.** A tapered snout. Fixed by a blunt, near-vertical snout disc: that
  single feature is what says "pig".
- **Mandrill**, then **cat** — both frontal, and both the same defect. Smooth
  continuous bezier curvature closes into an oval however far the control points
  are dragged, and a circle with small upright triangles on top is a cat
  whatever else is drawn inside it.
- **Tapir.** Back in profile, with the muzzle drawn as a slender tube of even
  width. A boar's muzzle is *deep* where it meets the cheek and only tapers at
  the very front; the taper is the whole difference.

Things that hold, whichever view is being drawn:

- **Tusk tips finish above the muzzle line.** Kept politely below, they read as
  teeth and the animal stops being a boar.
- **Tusks need a mouth to come out of.** Without one they are hooks leaning
  against the head — learned twice, once in each view.
- **The mane spine starts behind the ear.** Bristles rooted where the ear is
  drawn grow straight through it.
- **Facet washes must overlap, not meet.** A hairline of backdrop between two
  dark fills reads as a black seam splitting the animal in half.

Two defects were invisible in a static render and only showed up in the running
app: the bloom (`drop-shadow` at 26px over two wide blurs) had erased every
crease, the nostrils and the eye into white haze, and the tusks at full fill
opacity were flat grey slabs with no form in them. Bloom that deletes the
drawing it is lighting is not atmosphere.

The viewBox is larger than the drawing's bounds on purpose — the neon filter
blurs well outside the strokes and the SVG root clips at the viewBox, so a snug
box shears the glow off flat along one edge.

### Files changed

| File | Change |
|---|---|
| `main.go` | `BackgroundColour` — the native window is `--bg` before the webview paints |
| `frontend/index.html` | Inline critical `background`, the only rule that paints before the bundle |
| `frontend/src/lib/boar.ts` | New — `BOAR_VIEWBOX`, `NEON`, `SPLASH` timings, `boarStrokes`, `boarFacets`, `glitchBands`, `sparks` |
| `frontend/src/lib/boar.test.ts` | New — 180 cases: absolute-M/C/Z, NaN sweep, viewBox containment, draw order, load-bearing segments present, seeded determinism, timing budget |
| `frontend/src/components/Splash.tsx` | New — the projection and the anime.js timeline, reduced-motion path by hand |
| `frontend/src/store.ts` | `splashDone`, seeded from the dev once-per-session flag |
| `frontend/src/App.tsx` | Mounts `<Splash />` last, behind a `<Show>` |
| `frontend/src/styles.css` | `.splash-*` — backdrop, grid, scanlines, sweep, wordmark; the CSS half of reduced motion |
| `frontend/package.json` | `animejs` ^4.5.0 (MIT), the first runtime dependency beyond solid-js and chart.js |
