# yv

## 0.3.0

### Minor Changes

- [#11](https://github.com/lakshmaji/yv/pull/11) [`2602e2f`](https://github.com/lakshmaji/yv/commit/2602e2f0cd96a33ae02be0ebaf760992e7d07ab3) Thanks [@lakshmaji](https://github.com/lakshmaji)! - Commit a `yv.yaml` to a repository and yv can find it.

  Export is now YAML only, and writes `yv.yaml` by default — a file meant to live at a
  repo root rather than sit in a downloads folder. Point yv at the folder your code
  lives in (Settings → Project scanning) and it searches the sub-folders in the
  background, skipping dependency trees and build output, then asks about any config
  that is new or has changed since you last answered.

  Importing a config whose `id` matches a project you already have **replaces** it, so
  pulling a colleague's change gives you their command list including what they removed.
  Nothing is imported without you agreeing, and the review dialog shows every command in
  the file — including pre- and post-hooks — before you do. Importing never runs
  anything. Every import is recorded in a history you can read from the same dialog.

  The format is documented in [docs/yv-yaml.md](./docs/yv-yaml.md).

  Also fixes three pre-existing defects found on the way: `projects.json` and
  `settings.json` were written non-atomically, so a crash mid-write could lose every
  project; concurrent updates to `projects.json` were not serialised, so two saves could
  discard one another; and the peer-discovery node raced on its context when discovery
  was stopped and restarted.

  Files written by older versions still import — their lowercased keys are read as
  before.

## 0.2.2

### Patch Changes

- [#6](https://github.com/lakshmaji/yv/pull/6) [`1fe6a20`](https://github.com/lakshmaji/yv/commit/1fe6a205fe8b51f9d60ff09f006f954daa6cfadf) Thanks [@lakshmaji](https://github.com/lakshmaji)! - Fixed device discovery on macOS, which stopped finding anything after 0.2.0.

  The macOS app bundle had picked up a `NSBonjourServices` entry naming the wrong
  kind of service. That key restricts an app to the service types it lists, so an
  entry that matches nothing stops the app announcing itself and browsing for
  others — in both directions, which is why a Mac and a Linux machine that used to
  find each other went quiet at the same moment.

  Reverted along with the rest of the change it shipped in: the Windows installer
  no longer adds firewall rules, and the "found, but not reachable" wording in the
  no-devices dialog is gone for now. The firewall diagnosis those were built on was
  never actually measured, and on the affected Mac the firewall was switched off
  the whole time.

## 0.2.1

### Patch Changes

- [#4](https://github.com/lakshmaji/yv/pull/4) [`c9a6148`](https://github.com/lakshmaji/yv/commit/c9a6148d20c3165a772634e5724c9c433a4a4727) Thanks [@lakshmaji](https://github.com/lakshmaji)! - Fix releases publishing no installers.

  `v0.2.0` was a bare tag: the DMG, Windows installer, `.deb` and AppImage were all
  built, but nothing ever attached them. The tag was pushed with the automatic
  `GITHUB_TOKEN`, and GitHub suppresses workflow triggers for that token, so the
  build workflow never saw the tag — and the job that pushed it exited 0, so the
  failure was invisible.

  Tagging now runs through `changesets/action` with a `RELEASE_TOKEN`, which also
  opens the Release with the changelog entry as its body; the build workflow uploads
  the installers onto it. The hand-rolled versioning shell and both `workflow_dispatch`
  triggers are gone.

## 0.2.0

### Minor Changes

- [#1](https://github.com/lakshmaji/yv/pull/1) [`075bc10`](https://github.com/lakshmaji/yv/commit/075bc107f9c350f5845f9677cb307fa6fbacc462) Thanks [@lakshmaji](https://github.com/lakshmaji)! - Proper installers, and a fix for device sharing between machines that both
  have a firewall.

  **Windows now has an installer.** It puts yv in Program Files with a
  Start-menu entry and an uninstaller, installs the WebView2 runtime if it is
  missing (without which the app started and died with no window), and allows
  yv through Windows Firewall on private networks. The portable `.zip` is
  still there for anyone who would rather not install anything.

  **The macOS disk image now shows what to do with it** — yv beside an
  Applications shortcut, so it gets dragged somewhere it can update itself
  from. Opening it and double-clicking used to run yv off the disk image,
  which then refused every update.

  **Device sharing works between two firewalled machines.** Sharing needs to
  accept incoming connections, and two computers that both block them could
  find each other and never connect — each worked fine against a third
  machine, which made it look like one of them was broken. When it still
  cannot connect, the Discovery view now says so and names the fix, instead of
  reporting an empty network.

  The app icon is no longer the stock Wails placeholder, and on Windows the
  Help and View menus show real shortcut names instead of `Ctrl+OEM2`.

- [`1a2f554`](https://github.com/lakshmaji/yv/commit/1a2f5542e02a8374de960c4b957cc37f1a19d971) Thanks [@lakshmaji](https://github.com/lakshmaji)! - yv can now update itself. It checks GitHub for new releases, verifies the
  download against an RSA signature before trusting it, and installs it — on
  macOS, Windows, and the Linux AppImage. Package installs are told to use
  their package manager rather than offered a download that would not apply.

  Check from Help → Check for Updates…, or from About. A quiet check also runs
  a few seconds after launch and only speaks up when there is something to say.

- [`a9a3957`](https://github.com/lakshmaji/yv/commit/a9a39574b445b7f80b5cf018cf29ad9550318ca4) Thanks [@lakshmaji](https://github.com/lakshmaji)! - About now shows which version you are running. A build that skipped the
  Makefile reports `dev`, which is the honest answer rather than a blank.
