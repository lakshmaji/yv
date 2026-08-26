# 002 — Optional command description

**Status:** implemented.
**Scope:** one new optional string field on `Command`, a toolbar-assisted markdown editor in
the edit modal, and a preview icon + modal on the command row. Nothing else in the row, the
runner, or the wire protocols changes.

---

## Context

A command today is an id, a shell string, and a handful of run knobs — nothing explains what
it does or why it exists beyond what fits in the 200-character `label`. For a `yv.yaml`
committed to a repo and read by teammates via `git clone`, that is often not enough: "why does
`checkout-api-it` need `direnv exec . true` first" is exactly the kind of thing worth writing
down next to the command instead of in a separate README nobody opens.

`description` is a new optional field on `Command`: free-text markdown, written once in the
edit modal, read later from a preview modal reached by an icon on the row. It is documentation
only — never interpolated into the command, never executed, never shown unrendered anywhere a
user didn't ask for it. That keeps it inside the two invariants this repo already enforces
hardest: **import never executes**, and **the file is validated, never trusted** — a
multi-kilobyte hand-written string is exactly the kind of field `validateScanned` has to bound
like every other one.

### Ruled out — do not revisit

**A live split-pane preview inside the edit modal.** The ask is explicit: the edit modal is
where you *write* the description, and a separate icon + modal on the row is where you *read*
it rendered. A write/preview toggle inside `EditCommandModal` would be a second, redundant
place to render markdown and was not asked for.

**Storing rendered HTML instead of raw markdown.** The toolbar buttons insert markdown syntax
(`**bold**`, `[text](url)`, …) into the textarea; `Command.Description` is always the raw
markdown string, both in `projects.json` and in `yv.yaml`. Rendering happens once, at display
time, in one place (see Commit 2) — never persisted, never round-tripped through a WYSIWYG
DOM.

**Showing the description inline on the collapsed row.** `CommandRow` already has a lot in its
header (label, snippet, hook badge, resource badge, line-hint). The description is reachable
through the preview icon, not printed into the row itself.

**A generic "notes" field reused for something else later.** This is specifically the
documentation-for-humans field the spec doc describes commands needing; it is not a home for
metadata some other feature might want. YAGNI.

**A hover/CSS tooltip instead of the modal.** Considered and mocked up, then dropped:
descriptions are bounded at 20,000 characters, and a popover either clips long content or grows
a scrollbar inside itself — both worse than the modal it would have replaced. The icon keeps a
`title` attribute for hover affordance, but the click target is still the full-size modal from
Commit 4.

---

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Storage | New `Description string` field, `omitempty`, on `models.CommandConfig` | Matches every other optional field (`WorkingDir`, `Interactive`) |
| Bound | `maxDescriptionLen = 20_000` (~20 KB) in `internal/config/scan.go` | Generous for real documentation, still bounded like every other scanned field |
| Markdown rendering | `marked` (parse) + `dompurify` (sanitize before `innerHTML`) | First markdown surface in the app; hand-rolling a safe subset is more code to own for less correctness than two small, well-known libraries. Confirmed with the user over the zero-dependency alternative. |
| Editor UI | Toolbar (Bold / Italic / Link / List / Code) above a `<textarea>`, buttons wrap or insert markdown syntax at the current selection | Confirmed with the user over a plain textarea; still stores plain markdown, so this is presentation only |
| Preview trigger | New icon button in `.cmd-actions`, immediately before `.run-btn` | Matches the ask (a tooltip-style ⓘ icon ahead of Run) and the existing `hookBadge()` pattern of icons/badges that only render when there is something to show |
| Preview visibility | Icon renders only when `cmd.description` is non-empty | Nothing to preview otherwise; avoids a dead button on every row |

---

## Constraints on the implementation

- **Format change → format docs change in the same commit.** Per `CLAUDE.md`: `docs/yv-yaml.md`
  and `docs/examples/yv.yaml` land in the same commit as the `Description` field, and
  `internal/config/spec_test.go` asserts it round-trips, exactly like every other field in that
  table.
- **One commit per concern**, each independently buildable/testable — Go model + validation,
  frontend types, markdown rendering, editor UI, preview UI. No commit should require a later
  one to compile.
- **Frontend types stay hand-mirrored.** `frontend/src/types.ts` is typed by hand against
  `internal/models/models.go`, not generated — add `description?: string` there, not in
  `wailsjs/go/models.ts`.
- `frontend/src/wails.ts` / `store.ts` need no changes: `Description` rides through the existing
  `SaveProjects(projects)` call and the existing `editingCmd` signal — it's one more field on a
  struct that already saves whole.
- New runtime dependencies (`marked`, `dompurify`) go in `frontend/package.json`
  `dependencies`, not `devDependencies` — they run in the shipped app, not just at build time.
- Needs a changeset (`bunx changeset`) — CI's `changeset` job blocks without one.

---

## Commit 1 — `Description` field, validated and documented

**`internal/models/models.go:26-35`** — add `Description string
\`json:"description,omitempty"\`` to `CommandConfig`, alongside `WorkingDir`.

**`internal/config/scan.go`**:
- New const `maxDescriptionLen = 20_000` in the bounds block at line 32-36.
- In the `p.Commands` validation loop (around line 256-260, next to the existing
  `maxLabelLen`/`maxCommandLen` checks): `c.Description = strings.TrimSpace(c.Description)`,
  then reject with `fmt.Errorf("command %q has a description longer than %d characters", c.ID,
  maxDescriptionLen)` when it's over the bound. Same shape as the label/command checks right
  above it — reject, don't truncate, per `validateScanned`'s existing rule that a bad file is
  reported, not silently repaired.

**`docs/yv-yaml.md`** — add a `description` row to the Command field table (after `label`,
line ~108-113): `string`, no, —, "Free-text notes about the command, rendered as markdown in
the preview. Max 20,000 characters." Add a short `description:` block to the complete example
(one command in `docs/examples/yv.yaml`, e.g. `checkout-api-it`, gets 2-3 lines of markdown
covering a header, a list, and a link, since the doc's whole point is that every field in it is
exercised).

**`internal/config/spec_test.go`** — in `TestDocumentedExampleParses`, assert the description
on whichever command gained one (`it.Description != ""` plus a substring check), so a future
change that silently drops the field fails the suite instead of shipping quiet.

**Tests:** table-driven cases in `internal/config/scan_test.go` alongside the existing
label/command-length tests — under bound accepted and trimmed, over bound rejected with the
command id in the error, whitespace-only collapses to empty (so `omitempty` actually omits it).

---

## Commit 2 — shared markdown renderer

**New file `frontend/src/lib/markdown.ts`**: `renderMarkdown(md: string): string`, wrapping
`marked.parse` then `DOMPurify.sanitize`. One function, one place — both the preview modal
(Commit 4) and anything that reads descriptions later call this, not `marked` or `dompurify`
directly, the same reasoning `internal/share/transfer.go`'s single `gate()` already uses
elsewhere in this codebase for "one implementation, not two that drift."

**`frontend/package.json`** — add `marked` and `dompurify` (plus `@types/dompurify` if not
bundled) to `dependencies`.

**Tests:** `frontend/src/lib/markdown.test.ts` — a heading/list/link renders to the expected
tags; a `<script>` or an `onerror=` attribute embedded in the markdown is stripped by
sanitization. This is the one security-relevant path in the whole feature (rendered
user-authored content going into `innerHTML`) and is exactly where CLAUDE.md's existing
CSS-injection-vector concern for env colours applies again.

---

## Commit 3 — description field in the edit modal

**`frontend/src/components/modals/EditCommandModal.tsx`**:
- New signal `const [description, setDescription] = createSignal('');`, read from `c.description
  || ''` in the existing `createEffect` (line 23-38, alongside `label`/`group`/`command`), and
  written back in `handleSave`'s `setProjects(...)` call (line 61-74) as `description:
  description().trim()`.
- New section after the working-dir row (after line 149), before the interactive toggle:
  a small toolbar (`Bold` `Italic` `Link` `List` `Code` — plain buttons, no new dependency) that
  operate on the textarea via `selectionStart`/`selectionEnd`, wrapping the selection (bold/
  italic/code) or inserting a template at the cursor (link/list item), then a `<textarea
  class="description-input">` bound to `description()`. No preview here — see "Ruled out" above.

**Tests:** none beyond the existing frontend suite's coverage pattern for this modal, if any
exists — this is UI wiring, not logic; the toolbar's string manipulation (wrap-selection,
insert-at-cursor) is the one non-trivial piece and gets a small `describeMarkdownInsert`-style
pure helper (input text + selection + operation → output text + new cursor position) so it's
testable without mounting the component, alongside `markdown.test.ts`.

---

## Commit 4 — preview icon and modal on the command row

**`frontend/src/store.ts`** — new signal `const [previewingCmd, setPreviewingCmd] =
createSignal<string | null>(null);` next to `editingCmd` (line 325), exported at line 491,
same shape.

**New file `frontend/src/components/modals/DescriptionPreviewModal.tsx`** — same skeleton as
`EditCommandModal.tsx` (`Show when={previewingCmd()}`, `.modal-overlay`/`.modal-box`,
overlay-click and Cancel both close), body is a single `<div innerHTML={renderMarkdown(cmd()
?.description || '')} />` from Commit 2's helper. Read-only, no save/delete footer.

**`frontend/src/App.tsx:354`** — mount `<DescriptionPreviewModal />` next to
`<EditCommandModal />`; add `previewingCmd` to the "any modal open" check at line 140 (used for
things like suppressing shortcuts while a modal is up).

**`frontend/src/components/CommandRow.tsx`**:
- `handlePreview(e: MouseEvent)` — `e.stopPropagation(); setPreviewingCmd(props.cmd.id);`,
  same shape as `handleEdit` (line 84-87).
- New button in `.cmd-actions` (line 125-141), inserted right before `.run-btn` (line 135):
  `<Show when={props.cmd.description}><button class="preview-btn" title="Preview description"
  onClick={handlePreview}>ⓘ</button></Show>`. A hover `title` is enough affordance that it's a
  tooltip-style icon — the click still opens the full modal (see "Ruled out" above on why a
  hover popover doesn't replace it: descriptions run up to 20,000 characters and a popover
  clips or has to scroll inside itself, which is worse than the modal it'd be avoiding).

**Tests:** none beyond what the frontend suite already covers for `CommandRow`/modals, if
any — this commit is wiring the previous three together, with no new logic of its own.

---

## Commit 5 — changeset

`bunx changeset` — a `minor` bump (`feat`), one line: "Add an optional markdown description to
commands, editable in the edit modal and readable from a preview icon on the row."
