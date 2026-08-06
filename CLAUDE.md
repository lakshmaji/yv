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
