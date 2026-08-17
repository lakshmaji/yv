# `yv.yaml` — the project config format

[← back to the README](../README.md)

Commit a `yv.yaml` to a repository and yv can find it, import it, and keep it up to
date as your team changes it. It is the same file yv writes when you export a
project, so the usual way to start is to build the project in the app and export it.

## Where it goes

At the **root of a repository**, named exactly `yv.yaml` (or `yv.yml`). Nothing else
matches — `yv.yaml.example`, `.yv.yaml` and `config/yv.yaml` are all ignored by the
scanner, though you can still import them by hand.

## The shortest useful file

```yaml
id: checkout-api
name: Checkout API
commands:
  - id: checkout-api-up
    label: Start stack
    command: docker compose up -d
    group: Docker
```

That is everything required: an `id`, and at least one command with an `id` and a
`command`.

## A complete example

Every field below is exercised by
[`docs/examples/yv.yaml`](./examples/yv.yaml), which the test suite parses and
imports on every run — so this documentation cannot drift from what the app
actually accepts.

```yaml
id: checkout-api
name: Checkout API
labelBgColor: "#1f6feb"
labelTxColor: "#ffffff"

groups:
  - Docker
  - Test

groupPaths:
  Docker: deploy/local

commands:
  - id: checkout-api-up
    label: Start stack
    command: docker compose up -d
    group: Docker

  - id: checkout-api-logs
    label: Tail logs
    command: docker compose logs -f api
    group: Docker
    interactive: true

  - id: checkout-api-unit
    label: Unit tests
    command: go test ./... -short
    group: Test

  - id: checkout-api-it
    label: Integration tests
    command: ./scripts/integration.sh
    group: Test
    workingDir: /opt/fixtures
    preCommands:
      - direnv exec . true
    postCommands:
      - command: docker compose down
        timeout: 60

shortcuts:
  - id: checkout-api-verify
    name: Verify
    commandIds:
      - checkout-api-up
      - checkout-api-unit
```

## Field reference

### Project

| Key | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | **yes** | — | 1–64 characters of letters, digits, `.`, `-`, `_`. See [The id is the identity](#the-id-is-the-identity). |
| `name` | string | no | the folder name | What the sidebar shows. |
| `workingDir` | string | no | the folder holding the file | Usually best omitted — see [Paths](#paths). |
| `groups` | list of strings | no | derived from commands | Groups with no commands still appear. Max 50. |
| `groupPaths` | map of group → path | no | — | Per-group working directory override. |
| `commands` | list of [Command](#command) | **yes** | — | At least one usable entry. Max 500. |
| `shortcuts` | list of [Shortcut](#shortcut) | no | — | Runs several commands in order. |
| `labelBgColor` | string | no | theme | `#rgb` or `#rrggbb`. |
| `labelTxColor` | string | no | theme | `#rgb` or `#rrggbb`. |

### Command

| Key | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | **yes** | — | Must be unique within the file. |
| `command` | string | **yes** | — | The shell command. Max 8 KB. |
| `label` | string | no | — | Shown on the row. Max 200 characters. |
| `group` | string | no | — | Which group tab it appears under. |
| `workingDir` | string | no | the group or project dir | Overrides both. |
| `interactive` | bool | no | `false` | Shows a stdin box while the command runs. |
| `preCommands` | list of strings | no | — | Run in order **before** the command; a failure stops it starting. |
| `postCommands` | list of [PostCommand](#postcommand) | no | — | Run **after** the command finishes. |

### PostCommand

| Key | Type | Required | Default | Notes |
|---|---|---|---|---|
| `command` | string | **yes** | — | The shell command. |
| `timeout` | int | no | `120` | Seconds. |

### Shortcut

| Key | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | **yes** | — | |
| `name` | string | **yes** | — | |
| `commandIds` | list of strings | **yes** | — | Run in this order. Unknown ids are skipped. |

Keys are case-insensitive, so a file written by an older version of yv — which
emitted `workingdir` and `precommands` — still loads.

## The id is the identity

`id` is how yv decides whether an imported file is a **new** project or an update to
one you already have. Importing a file whose `id` matches an existing project
**replaces that project entirely** — its commands become exactly what the file says.

That is the point of committing the file: when a colleague adds a command and you
pull, importing gives you their list, including the commands they removed. It also
means:

- **Pick an id once and never change it.** Changing it makes a second, unrelated
  project rather than updating the first.
- **Prefix your command ids with the project id** (`checkout-api-up`, not `up`) so two
  repos cannot collide.
- Two repos sharing an `id` will overwrite each other. Use the repository name.

Nothing is ever replaced without you being asked, and the dialog shows every command
in the file before you agree.

## Paths

**Omit `workingDir` unless you have a reason not to.** When it is absent, yv uses the
folder the `yv.yaml` was found in — so the same committed file works on every
teammate's machine regardless of where they cloned it.

Set it only for a directory that is genuinely fixed, and note that an absolute path
from someone else's machine will not exist on yours. If a working directory is
missing when you press Run, yv asks you to pick one and remembers your answer.

## Automatic scanning

In **Settings → Project scanning**, choose the folder your repositories live in and
how often to look. yv then searches it in the background and asks about any
`yv.yaml` that is new or has changed since you last answered.

You can also scan at any time from **View → Scan for yv.yaml…** or the sidebar's
**Scan folder** button.

These directories are never searched:

| Skipped | Why |
|---|---|
| `node_modules`, `vendor`, `Pods`, `Carthage` | dependency trees |
| `build`, `dist`, `out`, `target`, `DerivedData`, `captures` | build output |
| `__pycache__` | tool cache |
| anything starting with `.` | `.git`, `.gradle`, `.cxx`, `.build`, `.next`, `.venv`, … |
| `*.xcodeproj`, `*.xcworkspace` | Xcode bundles |

If your config is not being found, check it is not inside one of these, and that it is
named exactly `yv.yaml` or `yv.yml`.

## What is deliberately not in this format

- **Environments and secrets.** Those live in a separate file with `0600` permissions
  and never travel with an exported or committed config. See the
  [environments guide](./environments.md).
- **Anything that runs on import.** There is no setup hook, and there will not be one.
  See below.

## A note on trust

A `yv.yaml` contains **shell commands written by whoever wrote the repository**. This
is the same trust you already extend to a `Makefile`, a `package.json` `scripts` block
or a `.envrc` — cloning a repository and building it means trusting its authors.

yv does not change that, but it does not make it quieter either:

1. **A scan never imports.** Nothing is written until you press Import.
2. **You see the commands first.** Every row in the review dialog expands to the full
   text of every command, including `preCommands` and `postCommands`, which are
   labelled because they run automatically around a command you did press Run on.
3. **Importing never executes anything.** Import writes configuration. Commands run
   when you press Run, exactly as if you had typed them.

Read a `yv.yaml` from a repository you do not know before importing it, the same way
you would read its `Makefile` before running `make`.

## Where imports are recorded

Every import — from a scan, from the file picker, or from a nearby device — is
appended to `import-history.jsonl` beside your config, and shown under **Recent
imports** in the scan dialog.

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/yv/import-history.jsonl` |
| Linux | `$XDG_CONFIG_HOME/yv/import-history.jsonl` (usually `~/.config/yv/`) |
| Windows | `%AppData%\yv\import-history.jsonl` |
