# yv

Wails v2 desktop app: a local dev command runner. Go backend, SolidJS +
TypeScript frontend, one webview. Projects hold groups of shell commands that
stream into per-row PTY terminals; devices on the same network find each other
over mDNS/libp2p and can share config or files. Builds for macOS, Linux and
Windows.

## What the product is for

The app is the runner. The thing being built is the **format**: `yv.yaml`, a
specification for a project's commands, committed to a repository beside the
code it builds — the way a `Makefile` or a `package.json` `scripts` block is.

A repo carrying a `yv.yaml` tells every machine that clones it what its commands
are. yv finds the file (a bounded folder scan, on a timer or on demand), shows
every command in it, and on import **replaces** the stored project with the same
`id` — so pulling a colleague's change updates your list, including the commands
they deleted. `docs/yv-yaml.md` is the specification; `docs/examples/yv.yaml` is
its executable half, parsed, validated and field-by-field asserted by
`internal/config/spec_test.go` on every test run. **A change to what the format
accepts is not done until that example and that doc change with it.**

What follows from being a specification rather than an app format:

- **The file is written by hand and arrives by `git clone`, so it is validated,
  never trusted.** `validateScanned` in `internal/config/scan.go` bounds every
  axis and rejects rather than repairs — a file quietly fixed is one whose author
  never learns it was wrong. Errors are reported per file, with a reason;
  dropping a bad file silently is the one outcome that teaches nobody anything.
- **Import never executes.** There is no setup hook and there will not be one.
  Import writes configuration; commands run when the user presses Run.
- **A scan never imports.** Nothing is written until the user presses Import in
  the review dialog, which shows the full text of every command, `preCommands`
  and `postCommands` included.
- Keys are named by the **json** struct tags (see `toYAML`/`fromYAML`), so the
  whole app has one set of field names. Matching is case-insensitive, which is
  what keeps pre-1.0 exports (`workingdir`, `precommands`) readable.

## Where things are documented

| Doc | Covers |
|---|---|
| [docs/yv-yaml.md](./docs/yv-yaml.md) | **The `yv.yaml` specification** — every field, the id rule, scanning, trust |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Project tree, tech stack, prerequisites, test/build/format commands, runtime config paths, versioning |
| [RELEASING.md](./RELEASING.md) | Release pipeline, signing keys, artifact table, troubleshooting |
| [FEATURES.md](./FEATURES.md) | User-facing behaviour |
| [docs/environments.md](./docs/environments.md) | Environment variable syntax and precedence |
| [docs/history.md](./docs/history.md) | How each feature came to be, and the reasoning behind it |

**Do not restate any of that here.** Below is orientation plus the things that
are not obvious from the code and would otherwise be re-broken.

## Working on this repo

```bash
make run            # wails dev (macOS);  make run-linux on Linux
make test           # test-go (with -race) + test-frontend
make fmt            # gofmt
cd frontend && bunx tsc --noEmit
```

Every PR needs a changeset (`bunx changeset`) — CI's `changeset` job blocks
without one, and a PR merged without it releases to nobody, silently.

## Shape of the system

`app.go` is a facade: every Wails-bound method is a thin wrapper that delegates
to an `internal/` package and returns a string error (`""` means success) or a
model. Logic does not live there — if a wrapper is growing a branch, the branch
belongs in the package it calls.

| Package | Owns |
|---|---|
| `internal/models` | every shared struct; the only package with no dependencies |
| `internal/config` | `projects.json`, YAML import/export, the `yv.yaml` scanner (`scan.go`), seen-hashes (`seen.go`), the import audit log (`history.go`) |
| `internal/settings` | `settings.json`, `Normalize`, `Validate`, change observers |
| `internal/runner` | PTY execution, stdin, pre/post commands |
| `internal/monitor` | CPU/RSS sampling of running commands |
| `internal/metrics` | append-only JSONL samples, retention |
| `internal/env` | `environments.json` (0600), colour validation |
| `internal/audio` | the user's own sound clips, read for the discovery view |
| `internal/share` | mDNS/libp2p discovery, connect-by-code, config and file transfer |
| `internal/updater`, `internal/updatesign` | check/download/verify/apply, signature format |
| `internal/atomicfile` | write-beside-fsync-rename; every config write goes through it |

Background work is a goroutine started from `startup` — `startScanMonitor`
(`app_scan.go`), `startUpdateWatch` (`app_update.go`), the resource-stats and
fullscreen loops. Never a `setInterval` in the frontend.

The frontend calls Go through `frontend/src/wails.ts` and receives streamed
output as Wails events keyed by command *and* run —
`output:<cmdID>:<runID>`, `done:<cmdID>:<runID>`, `post-done:<cmdID>:<runID>`
(see `frontend/src/lib/commands.ts`) — plus app-level
`resource-stats`, `scan:new`, and the update state event. State is plain SolidJS
signals in `store.ts`; there is no store framework and does not need to be one.

## Types

Shared structs live in `internal/models/models.go`. Root `models.go` re-exports
them as Go type aliases so Wails emits the TypeScript under the `main`
namespace. A new bound type needs an alias there and a mirror in
`frontend/src/types.ts`.

## Invariants and traps

### Config, scanning and import

- **`ApplyScanned` replaces by id; `ImportProjectsFromSlice` merges by id and
  skips.** They are deliberately separate functions, not one with a flag: the
  merge path is also where projects arriving from a nearby device land, and a
  peer on the network must never be able to overwrite a project. Both behaviours
  are pinned by tests so a later tidy-up cannot quietly unify them.
- `ApplyScanned` re-reads the files rather than trusting the parsed hits the
  caller holds — the review dialog can sit open for minutes and the disk is the
  truth.
- Every config write is `atomicfile` (temp file in the *target's* directory,
  fsync, rename), and every mutating `config.Store` method holds the mutex across
  its whole load → mutate → write cycle. `LoadProjects` deliberately takes no
  lock: atomic writes make a torn read impossible. The lock is never held across
  a file dialog.
- Duplicate command ids are rejected outright: run state, terminal output and
  metrics are all keyed by command id, so two commands sharing one cross-wire
  their output.
- The walk is bounded on every axis (entries, depth, hits, file size, deadline)
  because the root is a folder the user picked — possibly `$HOME` or a network
  mount — and it runs unattended. Hitting a bound sets `Truncated` and says which
  one; returning partial results silently reads as "that project has no
  `yv.yaml`", the exact wrong conclusion.
- Pruning is `skipDirs` plus **every dot-directory**, which is what covers
  `.git`, `.gradle`, `.cxx`, `.build`, `.venv` without listing them. `WalkDir`,
  not `Walk`: `fs.SkipDir` prunes without descending and it does not follow
  symlinks, which is what makes cycle detection unnecessary.
- `scan-seen.json` is keyed on path → **content hash**, so an edited config is
  offered again. Declining counts as answered; only the Import button marks, so
  dismissing the dialog leaves the prompt to return. A hit that failed to parse
  has no hash and therefore never falls silent. The file is nag suppression, not
  state: every failure reading it is swallowed and means "nothing answered yet".
- `import-history.jsonl` is written **after** the config write, never before, and
  `appendImports` returns no error — a failed audit write must not fail, or
  appear to fail, an import that already landed. It is wired into all three
  paths (scan, file picker, peer share); a log covering one of three is worse
  than none, because it looks complete.

### Discovery and sharing

- **Never re-add `NSBonjourServices` / `NSLocalNetworkUsageDescription` to
  `build/darwin/Info*.plist` with `_yv-share`.** That key *restricts* rather
  than permits, and `share.ServiceTag` is a bare tag where Apple requires
  `_name._udp` — so the list matches nothing and the Mac stops both announcing
  and browsing. It broke Mac↔Linux discovery in both directions and was reverted
  (`1fe6a20`; see the CHANGELOG entry). Doing it properly means changing
  `ServiceTag`, which is a wire-format break and needs its own release.
- Measure before writing any firewall rule: `socketfilterfw --getglobalstate` on
  macOS, `Get-NetConnectionProfile` on Windows. The last attempt wrote rules for
  a firewall that turned out to be switched off.
- Two protocols, deliberately additive so a version skew loses only one:
  `ShareProto` `/yv/share/1.1.0` (config, gzip'd JSON) and `FileProto`
  `/yv/files/1.0.0` (files, streamed, length-prefixed, no gzip — the payloads
  are already compressed). Both route through the single `gate()` in
  `internal/share/transfer.go`; the connection check, the user's prompt and the
  response byte have one implementation, not two that drift.
- The connect code never crosses the wire — only `HashPIN(code)` does, so the
  receiving device *cannot* display it. That is the entire mechanism, and
  `TestConnectCodeNeverReachesTheReceiverInTheClear` guards it.
- In-flight transfers hold their peer alive (`beginTransfer` / `transferring` in
  `internal/share/node.go`). Without it `sweep` and `probe` reap a peer part way
  through a large transfer — an open stream is better evidence a device is there
  than a missing multicast packet is that it is not. The frontend keeps
  `sharePeer` on `peer:lost` while `shareBusy()` for the same reason.
- `share.Node` must not publish its context outside its mutex: a `sweepLoop` from
  a previous `Start` is still reading it, and Stop → Start is just leaving and
  re-entering the Discovery view. Each loop owns the context it was started with.
- Inbound filenames are hostile: `SafeName` in `internal/share/files.go`, applied
  again in `WriteFiles` because that is the last step before a path is written.
  Files land `0644` (no execute bit, whatever the extension) and get the
  quarantine xattr on macOS.

### Update and release

- The signature covers the SHA-256 of the **32 decoded bytes** of the artifact
  hash, not its 64-character hex spelling (`internal/updatesign`,
  `SigningDigest`). Sign the string instead and everything verifies against
  itself and against nothing else.
- Asset names are pinned as **literals** in `internal/updater/updater_test.go`,
  against what CI actually uploads — deriving them from `platformToken` would
  only prove the function agrees with itself. The Windows `.zip` must keep
  existing (the updater unpacks it; a running `.exe` cannot be overwritten in
  place) and `-setup.exe` must never match `pickAsset`.
- `publish: bunx changeset tag` in `release.yml` is load-bearing: without it the
  action logs one info line and exits 0, and no tag, release or build happens.
  The push needs `RELEASE_TOKEN`, not `GITHUB_TOKEN` — a tag pushed by the bot
  triggers nothing. The changesets action is pinned to a commit because v2
  renamed every input and Actions ignores unknown inputs silently.

### Frontend

- CSS keyframes are cancelled by `prefers-reduced-motion` and the `.no-motion`
  class. **WAAPI / script animations are not** — `Drone.tsx` and `Splash.tsx`
  check both by hand, including a `matchMedia` listener since the OS setting can
  change while the app is open. Deliberate exemptions: the dinosaur roar and the
  drone burst are one-off responses to events, not ambient motion.
- Scenery drawn over the herd on the discovery map needs `pointer-events: none`.
  This has been a bug twice.
- `frontend/src/wails.ts` is typed against `types.ts`, **not** the generated
  `wailsjs/go/models.ts` — the generated file emits classes with a
  `convertValues()` member that plain object literals never satisfy.
- Env colours are written into inline `style` attributes, so they are validated
  on both sides (`env.ValidateColor`, `isValidColor`); an unvalidated value is a
  CSS-injection vector, and both test suites cover an injection attempt.
- Specificity trap in modals: `.modal-box input { width: 100% }` is a class plus
  an element, so it outranks a lone utility class whatever the source order. A
  narrow control has to name its ancestor
  (`.modal-box .settings-username-input`).

### Data

- Secrets live in `environments.json` (mode 0600), deliberately a separate file
  from `projects.json` so no export, share or committed `yv.yaml` can carry them.
  Deleting a project deletes its environments.
- New `models.Settings` fields keep zero-value-means-default — which is why the
  field that persists is `SoundMuted` rather than a sound-enabled flag, and why
  an empty `ScanDir` means scanning is off. Upgrading must never start walking
  someone's disk on its own; scanning is opted into.

### Art

The discovery map and the splash boar are pure functions in
`frontend/src/lib/landscape/*`, `drone.ts` and `boar.ts`, each with seeded tests
and dense in-file rationale. Read the file rather than a summary. Note that the
tests prove the geometry is well-formed, not that it looks like anything — five
drawings were thrown away and no test caught any of them, so a visual change has
to be looked at in the running app.

## Not verified

- The Windows apply path (`internal/updater/apply_windows.go`) compiles and its
  portable half is tested, but it has never been executed.
- The AppImage recipe was built and run on arm64 only; the x86_64 appimagetool
  download is unproven.
