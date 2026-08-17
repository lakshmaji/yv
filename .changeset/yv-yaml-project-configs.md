---
"yv": minor
---

Commit a `yv.yaml` to a repository and yv can find it.

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
