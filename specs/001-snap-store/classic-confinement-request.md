# Classic confinement request — forum post

Post to **forum.snapcraft.io**, category **store-requests**, from the account that owns the
`yv-tool` registration.

The store expects a short structured template, not an essay — see
[Classic confinement for Goose](https://forum.snapcraft.io/t/classic-confinement-for-goose/52725)
for the shape. Reviewers ask follow-up questions in the thread; the prepared answers below
are for those replies, **not** for the opening post.

> **Order of operations:** the `snapcraft:` field must link to a real `snap/snapcraft.yaml`.
> Land Commit 3 first, then post. Posting with a dead link invites an immediate "where is the
> recipe" round-trip.

---

## Title

```
Classic confinement for yv
```

## Body

```
- **name**: yv-tool
- **description**: A desktop app that runs a project's own development commands —
  build, test, lint, dev server — each streamed into its own terminal pane. The
  commands come from a `yv.yaml` file committed to the user's repository, so the
  set of tools invoked is defined by the user, not by this snap.
- **snapcraft**: https://github.com/lakshmaji/yv/blob/main/snap/snapcraft.yaml
- **upstream**: https://github.com/lakshmaji/yv
- **upstream-relation**: I am the upstream author; the snap recipe lives in the
  application's own repository.
- **supported-category**: tools for configuring development workspaces/environments
- **reasoning**: yv executes arbitrary host-installed developer tooling on the
  user's behalf — whatever their project's `yv.yaml` specifies. Strict interfaces
  grant only scoped file, socket and process access; none permits general
  execution of host binaries. In particular the `home` interface excludes
  dot-directories, where the common version managers (`~/.nvm`, `~/.cargo`,
  `~/.pyenv`, `~/.sdkman`) install the toolchains these commands invoke.
```

---

## Prepared answers for reviewer follow-ups

Do not pre-empt these in the opening post. Use them if asked.

### "Why not strict with `home`, `removable-media`, `docker`, `system-backup`?"

Two reasons, in order of weight:

1. `home` deliberately excludes dot-files and dot-directories. That is exactly where `~/.nvm`,
   `~/.cargo`, `~/.rustup`, `~/.pyenv`, `~/.rbenv`, `~/.sdkman`, `~/.gradle` and
   `~/.local/share/mise` live, so for a large fraction of developers their `node`, `cargo`,
   `python` and `java` are invisible and `npm run dev` fails immediately.
2. The executable set is unbounded and unknown at packaging time. A project may invoke `make`,
   `docker`, `kubectl`, `terraform`, `gradlew`, `bazel`, a shell script committed to the repo,
   or a tool that did not exist when the snap was built. It is read from the user's `yv.yaml`
   at runtime, so it cannot be enumerated in a plug list.

Also: users keep working trees on `/opt`, `/srv`, secondary drives and network mounts, and yv
scans a user-chosen directory for `yv.yaml` files.

### "Isn't this just difficulty with strict confinement?" (a denied category)

No — the failure is not partial function, it is *wrong* function. yv runs each command in a
PTY, and the whole value of the tool is that the command behaves exactly as it would in the
user's own terminal. A remapped `$HOME`, a snap-provided library path or a filtered environment
produces build output that differs from the same command run by hand. A build tool that
silently disagrees with the shell is worse than one that is not packaged at all.

### "What does the snap do that needs privilege beyond execution?"

Nothing. Specifically:

- No `snapd-control`; updates are left entirely to snapd's refresh.
- No root, no `sudo`, no `pkexec`.
- Import never executes. Importing a `yv.yaml` writes configuration only; commands run when
  the user presses Run. There is no setup hook and no post-install script.
- `yv.yaml` files arrive by `git clone` and are validated rather than trusted — bounded and
  rejected on every axis rather than repaired.
- Secrets live in a separate 0600 file that no export, share or committed config can carry.

### "Packaging questions"

- `base: core24`, `plugin: dump` over a binary built by the project's own CI.
- No `LD_LIBRARY_PATH` is exported; library paths are resolved by `enable-patchelf` rpath
  rewriting.
- Snap-injected variables (`SNAP*`, `WEBKIT_EXEC_PATH`) are stripped before any user command is
  spawned, so the snap does not leak its own runtime into the user's build environment.

### Category, if challenged

Stay with **"tools for configuring development workspaces/environments"**. It is the closest
published fit and the least of a stretch. **"Debug tools and IDEs"** is a reasonable secondary
if a reviewer suggests it, since the execution model is an IDE's run-configuration panel.

Do not claim orchestration or userless-systems categories — that is what drew an immediate
challenge in the Goose thread, and it is not what yv does.

---

## Notes

- The publisher is vetted, not just the snap. Expect questions about identity; the public
  MIT-licensed repository under the same GitHub account is the evidence.
- Answer follow-ups in the same thread rather than opening a second request.
- Expect days to weeks. Nothing else in this spec blocks on it — `yv-tool` reaches `edge`
  without approval, which is why Commit 4 publishes there.
