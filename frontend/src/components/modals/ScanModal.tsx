import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import {
  appSettings, scanHits, setScanHits, scanModalOpen, setScanModalOpen, setProjects,
} from '../../store';
import { go } from '../../wails';
import { shortenPath } from '../../lib/utils';
import type { ImportRecord, ScanHit } from '../../types';

/** A row is selectable only if the file actually parsed. */
function usable(hit: ScanHit): boolean {
  return !hit.error;
}

/**
 * Default selection: a new project arrives ticked, a replacement does not.
 *
 * A background scan that turns up eighteen files must not present eighteen
 * pre-armed overwrites — adding a project the user has never seen is additive,
 * replacing one they have been editing is not.
 */
function defaultSelection(hits: ScanHit[]): Set<string> {
  const sel = new Set<string>();
  for (const h of hits) {
    if (usable(h) && !h.exists && !h.unchanged) sel.add(h.path);
  }
  return sel;
}

/** A row is worth a decision only if it is importable and has actually moved. */
function actionable(hit: ScanHit): boolean {
  return usable(hit) && !hit.unchanged;
}

/**
 * Rows needing a decision first, then the ones already dealt with, then the
 * broken ones. Sorting beats hiding: a config that is present and up to date is
 * exactly what someone scrolling for a missing project needs to see.
 */
function ordered(hits: ScanHit[]): ScanHit[] {
  const rank = (h: ScanHit) => (h.error ? 2 : h.unchanged ? 1 : 0);
  return [...hits].sort((a, b) => rank(a) - rank(b));
}

export default function ScanModal() {
  const [root, setRoot] = createSignal('');
  const [hits, setHits] = createSignal<ScanHit[]>([]);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [scanning, setScanning] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal('');
  const [error, setError] = createSignal('');
  const [history, setHistory] = createSignal<ImportRecord[]>([]);
  const [showHistory, setShowHistory] = createSignal(false);
  // True when the dialog opened by itself with results the background job
  // found, which is a different situation from the user going looking.
  const [prompted, setPrompted] = createSignal(false);

  // `on` rather than a bare effect: the body reads scanHits(), and
  // importSelected clears it — so a plain effect would re-enter here the moment
  // an import finished, fire a fresh scan, and repaint the list the user had
  // just dealt with. Only the open/closed transition should set this up.
  createEffect(on(scanModalOpen, (open) => {
    if (!open) return;

    const pending = scanHits();
    const dir = appSettings().scanDir || '';
    setRoot(dir);
    setHits(ordered(pending));
    setSelected(defaultSelection(pending));
    setExpanded(new Set<string>());
    setPrompted(pending.length > 0);
    setNotice('');
    setError('');
    setShowHistory(false);
    void refreshHistory();

    // Opened by hand with a folder configured: scan straight away. The dialog
    // exists to show results, so making the user press Rescan to see any is a
    // step with no decision in it.
    if (!pending.length && dir) void rescan(dir);
  }));

  async function refreshHistory() {
    try {
      setHistory(await go.GetImportHistory(50));
    } catch {
      /* The history is context, never the point — a failure here is not worth
         a message over the decision the user came to make. */
    }
  }

  async function rescan(override?: string) {
    const dir = (override ?? root()).trim();
    if (!dir) {
      setError('Choose a folder to scan.');
      return;
    }
    setScanning(true);
    setError('');
    setNotice('');
    try {
      const res = await go.ScanForConfigs(dir);
      const found = ordered(res.hits || []);
      setHits(found);
      setSelected(defaultSelection(found));
      setPrompted(false);
      if (res.truncated) setError(res.truncated);
      else if (!res.hits?.length) setNotice(`No yv.yaml files under ${dir}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  async function browse() {
    const dir = await go.PickFolder();
    if (!dir) return; // cancelled
    setRoot(dir);
    void rescan(dir);
  }

  function toggle(path: string) {
    const next = new Set(selected());
    next.has(path) ? next.delete(path) : next.add(path);
    setSelected(next);
  }

  function toggleExpanded(path: string) {
    const next = new Set(expanded());
    next.has(path) ? next.delete(path) : next.add(path);
    setExpanded(next);
  }

  const selectable = createMemo(() => hits().filter(usable));
  // What is actually worth the user's attention, which is what the counts and
  // Select all speak to. Everything else is shown but not offered.
  const pendingChanges = createMemo(() => hits().filter(actionable));
  const unchangedCount = createMemo(() => hits().filter((h) => h.unchanged && !h.error).length);

  function selectAll() {
    setSelected(new Set(pendingChanges().map((h) => h.path)));
  }
  function selectNone() {
    setSelected(new Set<string>());
  }

  async function importSelected() {
    const paths = [...selected()];
    setBusy(true);
    setError('');
    try {
      if (paths.length) {
        const msg = await go.ApplyScanned(paths);
        if (msg.startsWith('error:')) {
          setError(msg);
          return;
        }
        setNotice(msg);
        setProjects(await go.LoadProjects() as any);
      }

      // Every row that was shown counts as answered, ticked or not: declining
      // is a decision, and re-asking about it every few hours is how a prompt
      // stops being read. Only reached from this button — dismissing the dialog
      // marks nothing, so an unanswered prompt comes back.
      await go.MarkScanSeen(hits());
      setScanHits([]);

      // Closing is the point: the decision has been made, and leaving the same
      // list on screen afterwards reads as though nothing happened. The result
      // is in the sidebar, and Recent imports has the receipt.
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setScanModalOpen(false);
  }

  const title = () => {
    if (!prompted()) return 'Scan for yv.yaml';
    const n = hits().length;
    return `${n} project ${n === 1 ? 'config' : 'configs'} found`;
  };

  return (
    <Show when={scanModalOpen()}>
      <div class="modal-overlay" onClick={(e) => e.target === e.currentTarget && close()}>
        <div class="modal-box scan-modal">
          <div class="modal-title">{title()}</div>
          <Show when={prompted() && root()}>
            <div class="scan-subtitle">in {root()}</div>
          </Show>

          <Show when={!prompted()}>
            <div class="scan-root-row">
              <span class="scan-root-label">Folder</span>
              <span class="scan-root-path" title={root() || undefined}>
                {root() ? shortenPath(root(), 4) : 'Not set'}
              </span>
              <button onClick={browse}>Browse…</button>
              <button onClick={() => rescan()} disabled={scanning() || !root()}>
                {scanning() ? 'Scanning…' : 'Rescan'}
              </button>
            </div>
          </Show>

          <Show when={hits().length > 0}>
            <div class="scan-toolbar">
              <div class="scan-toolbar-actions">
                <button onClick={selectAll} disabled={!pendingChanges().length}>Select all</button>
                <button onClick={selectNone} disabled={!selected().size}>Select none</button>
              </div>
              <span class="scan-count">
                {selected().size} of {hits().length} selected
                <Show when={unchangedCount()}>
                  <span class="scan-count-quiet"> · {unchangedCount()} unchanged</span>
                </Show>
              </span>
            </div>
          </Show>

          <div class="scan-list">
            <For each={hits()}>
              {(hit) => (
                <div class={'scan-hit' + (hit.error ? ' broken' : hit.unchanged ? ' unchanged' : '')}>
                  <div class="scan-hit-main">
                    <input
                      type="checkbox"
                      disabled={!usable(hit)}
                      checked={selected().has(hit.path)}
                      onChange={() => toggle(hit.path)}
                    />
                    <div class="scan-hit-body" onClick={() => usable(hit) && toggleExpanded(hit.path)}>
                      <div class="scan-hit-head">
                        <span class="scan-hit-name">
                          {hit.project?.name || hit.project?.id || 'unreadable'}
                        </span>
                        <Show
                          when={!hit.error}
                          fallback={<span class="scan-badge err">cannot import</span>}
                        >
                          <Show
                            when={!hit.unchanged}
                            fallback={<span class="scan-badge same">unchanged</span>}
                          >
                            <span class={'scan-badge ' + (hit.exists ? 'replace' : 'new')}>
                              {hit.exists ? 'replace' : 'new'}
                            </span>
                          </Show>
                          <span class="scan-hit-count">
                            {hit.exists
                              ? `${hit.existingCommands ?? 0} → ${hit.project.commands?.length ?? 0} commands`
                              : `${hit.project.commands?.length ?? 0} commands`}
                          </span>
                          <Show when={hit.dropped}>
                            <span class="scan-hit-dropped">{hit.dropped} skipped</span>
                          </Show>
                        </Show>
                      </div>
                      <div class="scan-hit-path" title={hit.path}>{shortenPath(hit.path)}</div>
                      <Show when={hit.error}>
                        <div class="scan-hit-error">{hit.error}</div>
                      </Show>
                    </div>
                    <Show when={usable(hit)}>
                      <button
                        class="scan-expand"
                        onClick={() => toggleExpanded(hit.path)}
                        title="Show the commands this file defines"
                      >
                        {expanded().has(hit.path) ? '▾' : '▸'}
                      </button>
                    </Show>
                  </div>

                  {/* The preview is the point of the prompt: a yv.yaml carries
                      shell commands written by whoever wrote the repo, and
                      agreeing to them unread is the thing being avoided. */}
                  <Show when={expanded().has(hit.path)}>
                    <div class="scan-preview">
                      <For each={hit.project.commands || []}>
                        {(cmd) => (
                          <div class="scan-cmd">
                            <div class="scan-cmd-head">
                              <span class="scan-cmd-label">{cmd.label || cmd.id}</span>
                              <Show when={cmd.group}>
                                <span class="scan-cmd-group">{cmd.group}</span>
                              </Show>
                            </div>
                            <code class="scan-cmd-text">{cmd.command}</code>
                            <Show when={cmd.preCommands?.length}>
                              <For each={cmd.preCommands}>
                                {(pre) => (
                                  <code class="scan-cmd-text hook">
                                    <span class="scan-hook-tag">before</span> {pre}
                                  </code>
                                )}
                              </For>
                            </Show>
                            <Show when={cmd.postCommands?.length}>
                              <For each={cmd.postCommands}>
                                {(post) => (
                                  <code class="scan-cmd-text hook">
                                    <span class="scan-hook-tag">after</span> {post.command}
                                  </code>
                                )}
                              </For>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </For>

            <Show when={!hits().length}>
              <div class="scan-empty">
                {root()
                  ? 'Nothing found yet — press Rescan.'
                  : 'Choose a folder to search for yv.yaml files.'}
              </div>
            </Show>
          </div>

          <div class="scan-history">
            <button class="scan-history-toggle" onClick={() => setShowHistory(!showHistory())}>
              {showHistory() ? '▾' : '▸'} Recent imports ({history().length})
            </button>
            <Show when={showHistory()}>
              <div class="scan-history-list">
                <For each={history()}>
                  {(rec) => (
                    <div class="scan-history-row">
                      <span class="scan-history-at">{rec.at?.slice(0, 16).replace('T', ' ')}</span>
                      <span class="scan-history-action">{rec.action}</span>
                      <span class="scan-history-name">{rec.projectName || rec.projectId}</span>
                      <span class="scan-history-path" title={rec.path}>
                        {rec.path ? shortenPath(rec.path) : rec.source}
                      </span>
                    </div>
                  )}
                </For>
                <Show when={!history().length}>
                  <div class="scan-empty">Nothing imported yet.</div>
                </Show>
              </div>
            </Show>
          </div>

          <Show when={error()}><div class="scan-error">{error()}</div></Show>
          <Show when={notice()}><div class="scan-notice">{notice()}</div></Show>

          <div class="modal-footer">
            <button class="btn-cancel" type="button" onClick={close}>
              {prompted() ? 'Not now' : 'Close'}
            </button>
            <button
              class="btn-primary"
              type="button"
              onClick={importSelected}
              disabled={busy() || !hits().length}
            >
              {busy()
                ? 'Importing…'
                : selected().size
                  ? `Import ${selected().size} project${selected().size === 1 ? '' : 's'}`
                  : 'Skip all'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
