# Development

How to build and run yv locally.

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | [Wails v2](https://wails.io/) |
| Backend | Go 1.25 |
| Frontend | SolidJS + TypeScript |
| PTY | [creack/pty](https://github.com/creack/pty) |
| Peer transport | [libp2p](https://libp2p.io/) + mDNS |
| Charts | [Chart.js](https://www.chartjs.org/) |

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Go | 1.25+ | [go.dev/dl](https://go.dev/dl/) |
| Bun | latest | [bun.sh](https://bun.sh/) |
| Wails CLI | v2 | `go install github.com/wailsapp/wails/v2/cmd/wails@latest` |

> Node.js 18+ works in place of Bun if you prefer — Bun is faster for `bun install` and `bun run test`.

### Linux: additional system packages

```bash
make deps-linux      # installs GTK, WebKit2 and the other packages Wails needs
make doctor-linux    # checks that everything is present
```

---

## Run in dev mode

```bash
make run             # hot reload — frontend and backend update on save
make run-linux       # same, with the Linux build tags
```

The first run downloads the Wails CLI if it is not already on your PATH. Subsequent runs are fast.

---

## Tests

```bash
make test            # Go tests (./...) + frontend tests (vitest)
make test-go         # Go tests only
make test-frontend   # frontend tests only (vitest, node environment)
```

The test suite covers all four internal packages (`config`, `runner`, `monitor`, `env`) and the frontend utilities (`search`, `heatmap`, `drone`, `audio`, `boar`, `river`, `sea`).

---

## Formatting

```bash
make fmt             # gofmt -w on all .go files (skips wailsjs/ generated files)
```

---

## Build

```bash
make build           # macOS ARM64 app bundle in build/bin/
```

### Platform packaging

```bash
make dmg             # macOS: yv.dmg in the project root (requires create-dmg or hdiutil)
make deb             # Linux: a .deb in build/bin/
make appimage        # Linux: the self-updating AppImage (requires appimagetool)
make install-linux   # build the .deb and install it locally
```

A build that goes through the Makefile embeds the current version. A build that skips it reports `dev` and never checks for updates.

---

## Project structure

```text
yv/
├── main.go              — Wails bootstrap, macOS title bar config, quit dialog
├── app.go               — App facade: thin Wails-bound wrappers for all methods
├── models.go            — type aliases re-exporting internal/models (keeps Wails TypeScript namespace)
├── go.mod / go.sum
├── wails.json           — build config, productVersion
├── Makefile
├── internal/
│   ├── models/          — all struct types shared across packages
│   ├── runner/          — PTY execution (ExecuteCommand, StopCommand, SendInput)
│   ├── config/          — persistence (LoadProjects, SaveProjects, Export/Import)
│   ├── monitor/         — resource stats polling (CPU, memory)
│   ├── env/             — environment variable store (0600, never in exports)
│   ├── share/           — peer discovery (mDNS + libp2p), connect-by-code, transfer
│   ├── updater/         — update check, download, verify, apply per platform
│   └── settings/        — settings store, validation, normalization
└── frontend/
    ├── index.html
    └── src/
        ├── index.tsx        — SolidJS entry point
        ├── App.tsx          — root: project loading, keyboard shortcuts, event wiring
        ├── store.ts         — SolidJS signals (projects, selectedId, cmdState, etc.)
        ├── types.ts         — TypeScript interfaces mirroring Go models
        ├── wails.ts         — typed Go bindings + Wails runtime re-export
        ├── styles.css       — all styles (CSS variables, grid, components)
        ├── lib/
        │   ├── commands.ts  — runCommand, runShortcut, step tracking
        │   ├── search.ts    — Spotlight: token matching, scoring, global search
        │   ├── audio.ts     — clip assignment, playback, loop management
        │   ├── drone.ts     — drone geometry, patrol route, burst shards
        │   └── landscape/   — procedural island: world, geometry, river, sea, palette
        └── components/
            ├── Sidebar.tsx
            ├── GroupsPanel.tsx
            ├── MainPanel.tsx
            ├── CommandRow.tsx
            ├── Terminal.tsx
            ├── Spotlight.tsx
            ├── DiscoveryPanel.tsx
            ├── StatusBar.tsx
            └── modals/
                ├── EditCommandModal.tsx
                ├── ShortcutModal.tsx
                ├── ProjectSettingsModal.tsx
                ├── EnvironmentsModal.tsx
                ├── ShareModal.tsx
                ├── IncomingShareModal.tsx
                ├── PeerConnectModal.tsx
                ├── IncomingConnectModal.tsx
                ├── NoDevicesModal.tsx
                ├── SettingsModal.tsx
                └── UpdateModal.tsx
```

**Import graph** (no cycles): `models` ← `runner`, `config`, `monitor`, `env`, `settings`; `monitor` also imports `runner`.

---

## Versioning

Versions are managed with [changesets](https://github.com/changesets/changesets).

Each PR should include a changeset:

```bash
bunx changeset      # interactive: pick patch / minor / major, describe the change
```

To cut a release locally (for testing the sync script):

```bash
bun run version     # runs `changeset version` + syncs the version into wails.json
```

The version lives in two files — `package.json` and `wails.json` — and `version_test.go` fails the build if they disagree.

Pushing a `v*` tag triggers CI: all three platforms build, artifacts are signed and uploaded, and a GitHub Release is created. See [RELEASING.md](./RELEASING.md) for the full pipeline and the signing key notes.

---

## Config files (runtime)

| Platform | Directory |
|---|---|
| macOS | `~/Library/Application Support/yv/` |
| Linux | `$XDG_CONFIG_HOME/yv/` (usually `~/.config/yv/`) |
| Windows | `%AppData%\yv\` |

| File | Holds |
|---|---|
| `projects.json` | projects, groups, commands, shortcuts |
| `settings.json` | app settings |
| `environments.json` | environment variables (**mode 0600**, never exported) |
| `metrics/` | resource samples (only if metrics are enabled in Settings) |

---

## Linting / type checking

```bash
cd frontend && bunx tsc --noEmit    # TypeScript type check (should be clean)
```

The Go side has no linter config beyond `gofmt`; the Makefile's `fmt` target covers it.

---

## Opening a pull request

1. Fork the repo and create a branch.
2. Run `make test` — all tests should pass.
3. Add a changeset: `bunx changeset`.
4. Open a PR against `main`.

A CI check (`changeset status`) will fail if the PR has no changeset file. That is intentional — it keeps the changelog and version in sync with every merge.

---

## Further reading

[docs/history.md](./docs/history.md) records how each feature was built and why
it works the way it does — useful when a piece of the codebase looks stranger
than it needs to. It is history, not a description of the current tree; this
file is the one that stays current.
