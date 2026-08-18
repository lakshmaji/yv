# 001 — Publish yv to the Snap Store

**Status:** design, not implemented.
**Scope:** packaging and distribution. Adds a fifth Linux artifact; changes no existing one.

---

## Context

yv ships four Linux artifacts today — `.deb`, `.tar.gz`, `.AppImage`, plus `.sha256`/`.sig`
sidecars — built by `.github/workflows/build.yml` on a `v*` tag.

**The AppImage's update path is not the problem and this change does not touch it.** It
works: `chmod +x` is paid once at first install, and every update after that is in-app.
`replaceAppImage` (`internal/updater/apply_linux.go`) chmods the staged file to 0755 before
the atomic rename, and `Relaunch` execs in place — the user never leaves yv and never
re-runs `chmod`. macOS is the same story via the `.dmg`.

What the snap adds is **distribution**, not a better updater:

- First install is `snap install yv-tool --classic` instead of finding a release page, picking
  the right asset, downloading it and placing it. It lands in the launcher with its icon.
- yv becomes findable — Snap Store, GNOME Software, `snap find`. Nothing points at the
  GitHub releases page today unless you already know it exists.
- Updates arrive without the app being opened at all. The AppImage can only update itself
  while running, so a copy left closed for two months is two months stale on next launch;
  snapd refreshes in the background regardless.
- It covers the users the `.deb` and `.tar.gz` strand — both install cleanly, neither can
  ever update. `internal/updater/apply_linux.go` says so in as many words.

### Ruled out — do not revisit

**Calling Snap Store APIs from inside yv.** Reading `api.snapcraft.io/v2/snaps/info/yv` is
possible; acting on it is not. Installing a refresh means talking to snapd's socket, which
requires the `snapd-control` interface — classified super-privileged and not granted to
third-party snaps. The best such code could do is tell the user to run `sudo snap refresh
yv`, which is worse than silence because snapd will do it unprompted anyway.

**Strict confinement.** yv runs arbitrary user shell commands in PTYs. Under strict
confinement the `home` interface cannot read hidden files, so `~/.nvm`, `~/.cargo`,
`~/.gradle` and `~/.docker` are invisible; the host toolchain is not executable; docker is
unreachable. The product does not work. Classic confinement is the only viable mode, and it
is what every snapped IDE and terminal emulator uses.

---

## Constraints on the implementation

- **New behaviour lives in new files.** Existing files are touched only where a new file has
  to be wired in — four call sites total, listed per commit, none more than a few lines. The
  snap must not become a branch threading through `internal/updater` or `internal/runner`.
- **One commit per change**, each independently shippable and each passing `make test` on its
  own. Hygiene fixes land before the packaging that motivates them.
- **Table-driven Go tests**, matching the existing style in
  `internal/updater/apply_linux_test.go`.
- Existing artifacts are unchanged. No existing CI job is modified — one job is added.

## Decisions

| Decision | Choice |
|---|---|
| Confinement | `classic` — required, see above |
| Base | `core24` (Ubuntu 24.04; matches the `ubuntu-latest` runner and its webkit2gtk-4.1) |
| Build method | Repack the binary the existing `linux-amd64` job already produced — no second toolchain |
| Channel now | `edge` on every tag; `edge` accepts classic snaps without review |
| Channel later | flip one word to `stable` once the store-requests forum thread is approved |
| Architectures | `amd64` only, matching the current Linux matrix |

---

## Phase 0 — store prerequisites

Account actions, not code. They block publishing only; every commit below can land first.

1. ~~Register the name.~~ **Done — registered as `yv-tool` on 2026-08-18.**
   `snapcraft register yv` fails with `reserved_name`: the store holds all very short names
   to prevent squatting, and two-character names are reserved as a matter of course. Rather
   than petition for a scarce name from a young project, the snap is named **`yv-tool`** with
   **`title: yv`** in `snapcraft.yaml`. Only the `snap install` line and the terminal command
   carry the longer name — the store listing shows the title, and the launcher entry comes
   from `build/linux/yv.desktop` (`Name=yv`), neither of which is affected.
   Renaming a published snap is not really possible — you would publish under a new name and
   orphan the old, with existing installs never migrating — so this is settled, not a
   placeholder.
2. `snapcraft export-login --snaps=yv-tool --acls package_access,package_push,package_update,package_release -`
   → store as the `SNAPCRAFT_STORE_CREDENTIALS` repo secret. Record its expiry in
   `RELEASING.md`; an expired token fails the release job late and quietly.
3. File the classic-confinement request in the `store-requests` category on
   forum.snapcraft.io. yv fits the published allowed category *"tools for configuring
   development workspaces/environments"*; the justification is that it executes the user's
   own project commands against the user's own toolchain, which no combination of interfaces
   expresses. Until it is approved the snap can only reach `edge`.

---

## Commit 1 — strip snap variables from command environments

Independent of the snap shipping. `SNAP_*` and `WEBKIT_EXEC_PATH` leaking into the PTYs that
run the user's build commands is a correctness bug for a command runner, and the wrapper in
Commit 3 is exactly what would introduce them.

**New file** `internal/env/snap.go` — `StripSnap(environ []string) []string`, removing `SNAP`,
any `SNAP_*`, and `WEBKIT_EXEC_PATH`. `internal/env` already owns environment merging, so this
sits beside `Merge` rather than inventing a second env builder.

**Existing file touched:** `internal/runner/runner.go:450` — wrap the `os.Environ()` that feeds
`env.Merge`. One line, next to the `PATH` override that is already there for the same class of
reason.

**Tests** — `internal/env/snap_test.go`, table-driven:

| Case | Expectation |
|---|---|
| nothing to strip | input returned unchanged |
| `SNAP=/snap/yv/x1` | removed |
| `SNAP_NAME`, `SNAP_REVISION`, `SNAP_USER_DATA` | removed |
| `WEBKIT_EXEC_PATH` | removed |
| `SNAPSHOT_DIR`, `MY_SNAP`, `SNAPPY` | **kept** — sloppy prefix matching is the easy bug here |
| malformed entry with no `=` | does not panic |
| ordering | preserved for surviving entries |

---

## Commit 2 — go quiet under snap

Scoped honestly, because the obvious objection is right: in steady state snapd has already
refreshed, the running version matches the newest GitHub release, `Check` returns
`ErrUpToDate`, and the silent startup path publishes nothing — **no dialog**. The
`UpdateManual` case only occurs in the lag between a release becoming refreshable and snapd's
next refresh.

It is still worth closing, for two reasons that do not depend on how wide that window is:

- When it *does* fire the advice is **wrong**. It points a snap user at the releases page to
  download an AppImage, and following it leaves them with two installs of yv. A rarely-seen
  wrong dialog is worse than a common one, because nobody has ever reviewed it.
- Independently of the dialog, every launch fires an unauthenticated `api.github.com` request
  four seconds in (`startupCheckDelay`, `app_update.go:28`), against a shared 60/hr per-IP
  budget, to answer a question snapd owns.

**New file** `internal/updater/snap_linux.go`:

- `snapName() string` — `os.Getenv("SNAP_NAME")`.
- `snapInstall(name string) *InstallState` — nil when not a snap; otherwise
  `&InstallState{CanSelfUpdate: false, Reason: "This copy of yv came from the Snap Store, which keeps it up to date automatically."}`.
  Takes the name as a parameter so the table test never touches the process environment —
  the same reason `classifyLinuxInstall` takes `writableDir` as a parameter.

**Existing files touched:**

- `internal/updater/apply_linux.go` — `InstallCheck()` gains a three-line guard calling
  `snapInstall(snapName())` before `classifyLinuxInstall`. `classifyLinuxInstall` itself is
  **not** modified, so its existing table test keeps passing untouched. Extend the file's
  header comment from three install shapes to four.
- `app_update.go` — in `runCheck` (line 179), return early when `install` is snap-managed,
  **before** `a.upd.Check(ctx)` issues any request. The silent startup path publishes nothing;
  the explicit Help → "Check for Updates…" path publishes `models.UpdateCurrent` carrying the
  snap reason, so a user who goes looking still gets an answer. Do **not** publish
  `UpdateManual` — `frontend/src/App.tsx:230` auto-opens the modal for that status, which is
  the nag being removed.

**Tests:**

- `internal/updater/snap_linux_test.go`, table-driven: empty name → nil; name set → non-nil
  with `CanSelfUpdate` false and a non-empty reason; and the snap branch winning even when
  `APPIMAGE` is also set — a snap that somehow sees `APPIMAGE` must not try to rename over a
  read-only squashfs.
- `app_update_test.go` — `runCheck` under a snap makes **no** request against the `httptest`
  feed (fail the handler if it is hit) and publishes no `UpdateManual`. `updater.feedURL` is a
  `var` for exactly this.

---

## Commit 3 — the snap recipe

All new files; the only existing file touched is `Makefile`, for one added target.

### `snap/snapcraft.yaml`

One part, `plugin: dump`, consuming a binary staged into the build context by CI rather than
compiling anything.

- `name: yv-tool`, `title: yv` — see Phase 0 for why the name is not `yv`. The `title` is what
  the Snap Store and GNOME Software display, so users still see "yv".
- `confinement: classic`, `base: core24`, `grade: stable`, `adopt-info: yv`.
- Version via `craftctl set version="$(...)"` in `override-pull`, reading the same
  `wails.json` → `info.productVersion` that `Makefile:10` and
  `build/linux/package-appimage.sh` read. **Do not add a fifth spelling of the version** —
  `version_test.go` already guards `package.json` against `wails.json`.
- `build-attributes: [enable-patchelf]`. Classic snaps get no library remapping from snapd, so
  the binary's `RPATH` must be rewritten to `$ORIGIN`-relative paths at build time. This works
  here because the Wails binary is cgo-linked — external linker, standard ELF interpreter. It
  would *not* work on a pure-Go statically linked binary, which is the documented patchelf
  failure case.
- `stage-packages`: `libgtk-3-0t64`, `libwebkit2gtk-4.1-0`, `libjavascriptcoregtk-4.1-0`,
  `procps` — the same runtime set `build/linux/package-deb.sh` already computes for the `.deb`,
  `procps` included because `internal/monitor` shells out to `ps`.
- **Do not use the `gnome` extension.** It is incompatible with classic confinement.
- `apps.yv-tool`: `command: bin/yv-launch`, `desktop: usr/share/applications/yv.desktop`. The
  app key **must** match the snap name — an app named `yv` inside a snap named `yv-tool` is
  invoked as `yv-tool.yv`, not `yv-tool`. Reuse
  `build/linux/yv.desktop` verbatim — it is already shared by the `.deb` and the AppImage, and
  a third spelling of the menu entry is how the icon ends up different depending on how you
  installed.

### `snap/local/yv-launch`

Deliberately minimal, because every variable it exports reaches the PTYs that run the user's
commands (see Commit 1). It sets exactly one thing:

- `WEBKIT_EXEC_PATH=$SNAP/usr/libexec/webkit2gtk-4.1` — WebKitGTK spawns a separate
  `WebKitWebProcess` binary and will not find the staged one without this. It is the single
  most likely cause of a snap that builds fine and shows a blank window.
- **Must not export `LD_LIBRARY_PATH`.** Avoiding it is the entire point of `enable-patchelf`,
  and one pointing into `$SNAP` breaks every command the user runs through yv by aiming their
  `node`/`python`/`gcc` at the snap's libraries.

**Existing file touched:** `Makefile` — a `snap:` target beside `appimage:`, same shape
(depends on `build-linux`, delegates to `snapcraft --use-lxd`).

---

## Commit 4 — publish from CI

**Existing file touched:** `.github/workflows/build.yml` — one **added** job, gated on
`startsWith(github.ref, 'refs/tags/v')`, needing the existing `build` job. No existing job is
modified.

1. `actions/download-artifact@v4` for the `linux-amd64` artifact.
2. Untar `yv-linux-amd64-<tag>.tar.gz` into the snapcraft part source directory — the same
   binary that went into the `.deb` and the `.AppImage`. One compile, three packages.
3. `snapcore/action-build@v1`.
4. `snapcore/action-publish@v1` with `snap: ${{ steps.build.outputs.snap }}`, `release: edge`,
   and `SNAPCRAFT_STORE_CREDENTIALS` in `env`. **Always pass `release`** — omitting it uploads
   without releasing, which is the failure mode where every job is green and nobody gets the
   update. It is the same class of trap as `publish: bunx changeset tag` in `release.yml`.
5. Upload the `.snap` to the GitHub release alongside the other artifacts, so a tag's assets
   stay a complete record of what shipped.

The snap gets **no** `.sha256`/`.sig` sidecar. Those exist so `internal/updater` can verify a
download it is about to install; the store signs and verifies snaps itself, and sidecars for an
asset `pickAsset` can never match would only imply the updater handles snaps.

---

## Commit 5 — docs and changeset

- **`RELEASING.md`** — `.snap` row in the artifact table; "Linux `.snap` — yes, via snapd" in
  the self-update matrix; `SNAPCRAFT_STORE_CREDENTIALS` and its expiry documented beside
  `YV_UPDATE_PRIVATE_KEY` and `RELEASE_TOKEN`; the `edge` → `stable` flip noted as a one-word
  change once the forum request lands.
- **`DEVELOPMENT.md`** — `make snap` beside `make deb` / `make appimage`, and
  `snap install yv-tool --classic --edge` as the install line, with a one-line note that the
  snap is named `yv-tool` because `yv` is store-reserved.
- **`CLAUDE.md`** — under "Not verified": the snap is edge-only until the classic-confinement
  request is approved, and has been built on amd64 only. Under the Linux updater notes, the two
  things most likely to be re-litigated later:
  1. yv does not query the Snap Store because `snapd-control` is super-privileged and
     unavailable, so detection without action is worse than silence.
  2. The snap branch in `InstallCheck` covers a narrow window and is kept because the advice it
     replaces is *wrong*, not because the window is wide.
- `bunx changeset` — the `changeset` job blocks the PR without one.

---

## Verification

Local, before any CI run:

1. `make test` (includes `-race`) and `cd frontend && bunx tsc --noEmit`. After **each** commit,
   not just at the end — each has to stand alone.
2. `snapcraft --use-lxd`, then `sudo snap install --classic --dangerous ./yv-tool_*.snap`.
3. **Launch from the desktop menu, not a terminal.** A snap launched from a shell inherits
   environment a menu launch does not, and the blank-window WebKit failure only appears on the
   clean path.
4. In the running app, create two commands: one printing `env | grep -c '^SNAP'`, one running a
   tool from a hidden dotfile directory (`~/.nvm/versions/node/*/bin/node --version`). The first
   must print `0`; the second must succeed. These are the whole reason for classic confinement
   and Commit 1, and both fail in ways that look like unrelated user error.
5. No update dialog on launch. Help → "Check for Updates…" reports the Snap Store message rather
   than opening a download page.
6. Once a second tag exists: `sudo snap refresh yv-tool --channel=edge` with the app running,
   confirming refresh-app-awareness defers rather than killing live PTYs.

CI, on a real tag:

7. The `.deb`, `.tar.gz`, `.AppImage` and their sidecars are unchanged in shape from the previous
   release — the added job must not have perturbed the build job.
8. `snap info yv-tool` shows the new revision on `edge`, and the GitHub release carries the
   `.snap`.

## Risks

- **Classic plus staged WebKit is the fiddly part.** If `enable-patchelf` cannot patch the
  binary, or WebKit still cannot find its web process, the fallback is to drop `stage-packages`
  and depend on the host's `libwebkit2gtk-4.1-0` — a much smaller snap that fails at runtime on
  a host without it. Decide only after seeing the actual failure, not in advance.
- **The forum review is a human gate** with no committed timeline. Shipping to `edge` from day
  one is what keeps everything else from blocking on it.
- **Snap size** with GTK and WebKit staged will be 200 MB+. Normal for a snapped WebKit app and
  not worth optimising before it works.

## References

- [Reviewing classic confinement snaps](https://snapcraft.io/docs/reference/administration/reviewing-classic-confinement-snaps/) — the allowed/denied category list and the request process
- [Classic confinement](https://documentation.ubuntu.com/snapcraft/latest/explanation/classic-confinement/) — patchelf, `$RPATH`, and the Go-linker caveat
- [The snapd-control interface](https://snapcraft.io/docs/reference/interfaces/snapd-control-interface/) — why yv cannot trigger its own refresh
- [Refresh awareness](https://snapcraft.io/docs/explanation/how-snaps-work/refresh-awareness/) — refresh inhibition while an app is running
- [snapcore/action-build](https://github.com/snapcore/action-build) and [snapcore/action-publish](https://github.com/snapcore/action-publish) — the CI actions and `SNAPCRAFT_STORE_CREDENTIALS`
