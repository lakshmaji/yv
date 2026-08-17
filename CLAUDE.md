# yv

Wails v2 desktop app: a local dev command runner. Go backend, SolidJS +
TypeScript frontend, one webview. Projects hold groups of shell commands that
stream into per-row PTY terminals; devices on the same network find each other
over mDNS/libp2p and can share config or files. Builds for macOS, Linux and
Windows.

## Where things are documented

| Doc | Covers |
|---|---|
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Project tree, tech stack, prerequisites, test/build/format commands, runtime config paths, versioning |
| [RELEASING.md](./RELEASING.md) | Release pipeline, signing keys, artifact table, troubleshooting |
| [FEATURES.md](./FEATURES.md) | User-facing behaviour |
| [docs/environments.md](./docs/environments.md) | Environment variable syntax and precedence |
| [docs/history.md](./docs/history.md) | How each feature came to be, and the reasoning behind it |

**Do not restate any of that here.** This file is only for the things that are
not obvious from the code and would otherwise be re-broken.

## Working on this repo

```bash
make run            # wails dev (macOS);  make run-linux on Linux
make test           # test-go + test-frontend
make fmt            # gofmt
cd frontend && bunx tsc --noEmit
```

Every PR needs a changeset (`bunx changeset`) — CI's `changeset` job blocks
without one, and a PR merged without it releases to nobody, silently.

## Types

Shared structs live in `internal/models/models.go`. Root `models.go` re-exports
them as Go type aliases so Wails emits the TypeScript under the `main`
namespace. A new bound type needs an alias there and a mirror in
`frontend/src/types.ts`.

## Invariants and traps

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
  from `projects.json` so no export or share can carry them. Deleting a project
  deletes its environments.
- New `models.Settings` fields keep zero-value-means-default — which is why the
  field that persists is `SoundMuted` rather than a sound-enabled flag.

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
