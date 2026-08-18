# Classic confinement request — forum post draft

Post to **forum.snapcraft.io**, category **store-requests**, from the account that owns the
`yv-tool` registration. Title and body below are ready to paste.

Expect a wait of days to weeks. Reviewers will ask follow-up questions in the thread; answer
them there rather than opening a second request. Until this is granted, `yv-tool` can only be
released to `edge` — which is why nothing else in this spec blocks on it.

---

## Title

```
Request for classic confinement: yv-tool
```

## Body

```
## Summary

yv is a desktop application that runs a project's own development commands — the
build, test, lint and dev-server commands that already live in that project's
repository — and streams each one into its own terminal pane. It is a GUI
front-end for a developer's existing toolchain, in the same family as an IDE's
run-configuration panel or a graphical `make` runner.

I am requesting classic confinement because the commands yv executes are
authored by the user, not by me, and target the user's own toolchain installed
on the host. There is no set of interfaces that expresses "run whatever this
developer's project needs", because the set is unbounded and unknown at
packaging time.

- Snap name: yv-tool
- Source: https://github.com/lakshmaji/yv (MIT)
- Built with: Go + Wails v2 (GTK3 / WebKitGTK), SolidJS frontend

## Category

This falls under the published supported category **"tools for configuring
development workspaces/environments"**, and is closely adjacent to **"debug
tools and IDEs"**. The precedent I am relying on is the set of already-classic
snapped development environments — `code`, `intellij-idea-community`,
`sublime-text` and similar — which are classic for the same underlying reason:
they execute the user's arbitrary project tooling.

## Why strict confinement does not work

These are concrete failures, not general inconvenience.

1. **Language version managers live entirely in hidden directories.** The `home`
   interface deliberately excludes dot-files and dot-directories, so `~/.nvm`,
   `~/.cargo`, `~/.rustup`, `~/.pyenv`, `~/.rbenv`, `~/.sdkman`, `~/.gradle` and
   `~/.local/share/mise` are all invisible. For a large fraction of developers
   that is where their `node`, `cargo`, `python` and `java` actually are, so the
   overwhelmingly common case — `npm run dev` — fails immediately.

2. **The binaries being executed are on the host and are not known in advance.**
   A user's project may invoke `make`, `docker`, `kubectl`, `terraform`,
   `gradlew`, `bazel`, a shell script committed to their repo, or a tool that
   did not exist when this snap was built. Staging them is not possible; the
   command text comes from a `yv.yaml` file committed to the user's repository
   and is read at runtime.

3. **Projects are not confined to $HOME.** Users keep working trees on
   `/opt`, `/srv`, secondary drives and network mounts. yv also scans a
   user-chosen directory for `yv.yaml` files, and that directory is whatever
   they pick.

4. **Container and daemon sockets.** Commands routinely talk to
   `/var/run/docker.sock` or a rootless podman socket, and to project-local
   language servers and dev servers on arbitrary ports.

5. **Toolchain environment must be the user's, unmodified.** yv runs each
   command in a PTY and the command must observe the same environment the user's
   own shell would. A remapped $HOME, a snap-provided library path, or a
   filtered environment produces build output that differs from what the same
   command produces in a terminal — which makes the tool actively misleading
   rather than merely limited.

## What yv does not do

- It does not run anything on import or on install. Importing a `yv.yaml`
  writes configuration only; commands run when the user presses Run. There is no
  setup hook and no post-install script.
- It does not request `snapd-control` and does not manage snaps. Updates are
  left entirely to snapd's own refresh.
- It does not require root, and does not invoke `sudo` or `pkexec`.
- Configuration is validated rather than trusted: `yv.yaml` files arrive by
  `git clone` and are bounded and rejected on every axis rather than repaired.
- Secrets are stored in a separate 0600 file that no export, share or committed
  config can carry.

## Packaging notes

- `base: core24`, `plugin: dump` over a binary built by the project's own CI.
- No `LD_LIBRARY_PATH` is exported; library paths are resolved via
  `enable-patchelf` rpath rewriting.
- Snap-injected environment variables (`SNAP*`, `WEBKIT_EXEC_PATH`) are stripped
  before any user command is spawned, so the snap does not leak its own runtime
  into the user's build environment.

Happy to answer any questions or make packaging changes the reviewers would
prefer.
```

---

## Notes for whoever posts this

- The "What yv does not do" section is doing real work: the published denied-categories list
  rules out snaps wanting "direct access to sudo or pkexec" and snaps that are "simply facing
  difficulty with strict confinement". Stating plainly that yv needs neither, and that import
  never executes, heads off the two most likely objections.
- Point 5 is the strongest argument and the one least likely to be volunteered by a reviewer:
  the failure mode of a confined build is not "some things do not work", it is "the same
  command produces different output than in a terminal", which is worse than not shipping.
- If a reviewer proposes strict with `home`, `removable-media`, `docker` and `system-backup`,
  the answer is point 1 — `home` excludes dot-directories, which is where the toolchains are —
  plus point 2, that the executable set is unbounded.
- The publisher must also be vetted; expect questions about identity and the project's
  provenance. The GitHub account and the MIT-licensed public source are the evidence.
