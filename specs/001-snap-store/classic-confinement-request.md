# Classic confinement request — forum post

Post to **forum.snapcraft.io**, category **store-requests**, from the account that owns the
`yv-tool` registration.

The store expects a short structured template, not an essay — see
[Classic confinement for Goose](https://forum.snapcraft.io/t/classic-confinement-for-goose/52725)
for the shape. The template comes first, then two short sections answering the questions a
reviewer would otherwise ask anyway; each avoided round-trip is days of wall-clock time.

Two things are deliberately **not** in the opening post:

- **The "this is not merely difficulty with strict confinement" rebuttal.** That is a *denied*
  category, and naming it in your own request plants the objection. The substance is folded
  into the strict-confinement section as one sentence about producing wrong output rather than
  partial function, without naming it.
- **Packaging detail.** Reviewers read the linked `snapcraft.yaml`. It stays below the fold.

> **Before posting:** the `snapcraft:` field points at `snap/snapcraft.yaml` on the
> `feat/snapstore` branch. That file is Commit 3 and is not written yet, so the link 404s
> until it is pushed. Write Commit 3, push, confirm the URL returns 200, then post — a dead
> link invites an immediate "where is the recipe" round-trip, which costs days.
>
> **If `feat/snapstore` is later merged and deleted, this link dies and the reviewer sees
> a 404 weeks into the thread.** Before deleting the branch, edit the forum post to point at
> `/blob/main/snap/snapcraft.yaml`, or pin the commit (`/blob/<sha>/snap/snapcraft.yaml`) —
> a SHA survives branch deletion.
>
> Everything between the ``` fences is postable text. Nothing else in this file is — do not
> paste the notes.

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
- **snapcraft**: https://github.com/lakshmaji/yv/blob/feat/snapstore/snap/snapcraft.yaml
- **upstream**: https://github.com/lakshmaji/yv
- **upstream-relation**: I am the upstream author; the snap recipe lives in the
  application's own repository.
- **supported-category**: tools for configuring development workspaces/environments
- **reasoning**: yv executes arbitrary host-installed developer tooling on the
  user's behalf — whatever their project's `yv.yaml` specifies. Strict interfaces
  grant only scoped file, socket and process access; none permits general
  execution of host binaries. Detail below.

### Why strict confinement does not cover this

1. **`home` excludes dot-directories.** That is where `~/.nvm`, `~/.cargo`, `~/.rustup`,
   `~/.pyenv`, `~/.rbenv`, `~/.sdkman`, `~/.gradle` and `~/.local/share/mise` live, so for a
   large fraction of developers their `node`, `cargo`, `python` and `java` are invisible and
   `npm run dev` fails immediately.
2. **The executable set is unbounded and unknown at packaging time.** A project may invoke
   `make`, `docker`, `kubectl`, `terraform`, `gradlew`, `bazel`, a shell script committed to
   the repo, or a tool that did not exist when this snap was built. It is read from the user's
   `yv.yaml` at runtime, so it cannot be enumerated in a plug list.
3. **Working trees are not confined to `$HOME`.** Users keep them on `/opt`, `/srv`, secondary
   drives and network mounts, and yv scans a user-chosen directory for `yv.yaml` files.
4. **The environment must be the user's, unmodified.** Each command runs in a PTY and the
   value of the tool is that it behaves exactly as it would in the user's own terminal. A
   remapped `$HOME` or a snap-provided library path does not merely restrict the command, it
   makes it produce different output than the same command run by hand.

### What it does not need

- No `snapd-control`. Updates are left entirely to snapd's refresh.
- No root, no `sudo`, no `pkexec`.
- Import never executes. Importing a `yv.yaml` writes configuration only; commands run when
  the user presses Run. There is no setup hook and no post-install script.
- `yv.yaml` files arrive by `git clone` and are validated rather than trusted — bounded and
  rejected on every axis rather than repaired.
- Secrets live in a separate 0600 file that no export, share or committed config can carry.
```

---

## Held in reserve

Not in the opening post. Use only if a reviewer raises the matching point.

### If accused of "simply facing difficulty with strict confinement"

The failure is not partial function, it is wrong function — a build tool that silently
disagrees with the user's shell is worse than one that is not packaged at all. Point 4 above
already states this; expand it only if challenged, and do not name the denied category first.

### Packaging questions

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
