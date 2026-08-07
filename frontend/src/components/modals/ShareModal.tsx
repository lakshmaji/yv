import { createMemo, createSignal, onCleanup, onMount, Show, For } from 'solid-js';
import {
  projects,
  selectedId,
  sharePeer,
  shareBusy,
  setShareBusy,
  shareError,
  setShareError,
  shareDone,
  setShareDone,
  sendProgress,
  resetShareState,
} from '../../store';
import { go } from '../../wails';
import { formatBytes } from '../../lib/utils';
import type { ShareScope } from '../../types';

/** How long a success message stays up before the modal closes itself. */
const DONE_MS = 1600;

/**
 * Mirrors share.MaxFileBytes and share.MaxTotalBytes on the Go side. Only used
 * to say what the limits are — Go enforces them, and does so from file metadata
 * before reading a single byte off disk.
 */
const MAX_FILE_MB = 500;
const MAX_TOTAL_GB = 1;

/**
 * Chooses what to send to the peer whose dinosaur was tapped.
 *
 * By this point the two devices are connected: someone at the other end typed
 * the code that was read to them. Nothing here can fail for a reason the user
 * could have been told before they started choosing.
 *
 * Environments are never included in a config share — secrets live in their own
 * file precisely so they do not travel with shared config — and the receiver
 * still has to accept, so nothing here can push anything onto another machine
 * unattended.
 */
export default function ShareModal() {
  const peer = () => sharePeer();

  const [scope, setScope] = createSignal<ShareScope>('project');
  const [projectId, setProjectId] = createSignal(selectedId() ?? '');
  // Absolute paths on this machine; the file itself is only read in Go, at the
  // moment of sending.
  const [files, setFiles] = createSignal<string[]>([]);
  const [picking, setPicking] = createSignal(false);

  let doneTimer: ReturnType<typeof setTimeout> | undefined;

  // With no project selected, "this project" has nothing to mean.
  const canPickProject = () => projects.length > 0;

  const chosenProject = createMemo(() => projects.find((p) => p.id === projectId()) ?? null);

  const commandCount = createMemo(() => {
    if (scope() === 'app') {
      return projects.reduce((n, p) => n + (p.commands?.length ?? 0), 0);
    }
    return chosenProject()?.commands?.length ?? 0;
  });

  const ready = () => {
    if (shareBusy() || shareDone()) return false;
    if (scope() === 'project' && !chosenProject()) return false;
    if (scope() === 'files' && files().length === 0) return false;
    return true;
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(doneTimer);
    });
  });

  function close(): void {
    clearTimeout(doneTimer);
    resetShareState();
  }

  function onOverlayClick(e: MouseEvent): void {
    // Closing mid-transfer would orphan a prompt on the other machine.
    if (e.target === e.currentTarget && !shareBusy()) close();
  }

  async function pickFiles(): Promise<void> {
    if (picking() || shareBusy()) return;
    setPicking(true);
    try {
      const picked = await go.PickFilesToShare();
      if (picked.length === 0) return; // cancelled
      // Added to the list rather than replacing it, so a second trip to the
      // dialog can reach a different folder without losing the first choice.
      // De-duplicated by path: picking the same file twice would send it twice.
      setFiles((cur) => [...new Set([...cur, ...picked])]);
      setShareError(null);
    } catch (e) {
      setShareError(String(e));
    } finally {
      setPicking(false);
    }
  }

  function removeFile(path: string): void {
    setFiles((cur) => cur.filter((p) => p !== path));
  }

  async function send(): Promise<void> {
    const target = peer();
    if (!target || !ready()) return;

    setShareError(null);
    setShareBusy(true);

    try {
      const res =
        scope() === 'files'
          ? await go.InitiateFileShare(target.id, files())
          : await go.InitiateShare(target.id, scope(), projectId());

      if (res.startsWith('error:')) {
        setShareError(friendlyError(res.slice(6).trim()));
        return;
      }
      // Go only returns ok once the receiver confirmed it applied the payload,
      // so this genuinely means "landed", not "sent".
      setShareDone(doneMessage(target.name));
      doneTimer = setTimeout(close, DONE_MS);
    } catch (e) {
      setShareError(friendlyError(String(e)));
    } finally {
      setShareBusy(false);
    }
  }

  /**
   * Once bytes are moving, "Waiting for them to accept…" is a lie — they have
   * accepted, and what is left is the transfer itself.
   */
  const sendLabel = () => {
    if (!shareBusy()) return 'Send';
    return sendProgress() ? 'Sending…' : 'Waiting for them to accept…';
  };

  function doneMessage(peerName: string): string {
    if (scope() === 'files') {
      const n = files().length;
      return `Sent ${n} file${n === 1 ? '' : 's'} to ${peerName}`;
    }
    if (scope() === 'app') {
      return `Sent ${projects.length} project${projects.length === 1 ? '' : 's'} to ${peerName}`;
    }
    return `Sent ${chosenProject()?.name ?? 'project'} to ${peerName}`;
  }

  return (
    <div class="modal-overlay" onClick={onOverlayClick}>
      <div class="modal-box share-modal">
        <div class="modal-title">Share with {peer()?.name}</div>

        <Show when={shareDone()}>
          <div class="share-done">✓ {shareDone()}</div>
        </Show>

        <Show when={!shareDone()}>
          <div class="modal-field-label">What to share</div>
          <div class="share-scope">
            <button
              type="button"
              class="share-scope-option"
              classList={{ selected: scope() === 'project' }}
              disabled={shareBusy() || !canPickProject()}
              onClick={() => setScope('project')}
            >
              <span class="share-scope-name">One project</span>
              <span class="share-scope-detail">Just its commands and shortcuts</span>
            </button>
            <button
              type="button"
              class="share-scope-option"
              classList={{ selected: scope() === 'app' }}
              disabled={shareBusy()}
              onClick={() => setScope('app')}
            >
              <span class="share-scope-name">Everything</span>
              <span class="share-scope-detail">
                All {projects.length} project{projects.length === 1 ? '' : 's'}
              </span>
            </button>
            <button
              type="button"
              class="share-scope-option"
              classList={{ selected: scope() === 'files' }}
              disabled={shareBusy()}
              onClick={() => setScope('files')}
            >
              <span class="share-scope-name">Files</span>
              <span class="share-scope-detail">Anything on this machine</span>
            </button>
          </div>

          <Show when={scope() === 'project'}>
            <select
              class="share-project-select"
              value={projectId()}
              disabled={shareBusy()}
              onChange={(e) => setProjectId(e.currentTarget.value)}
            >
              <Show when={!canPickProject()}>
                <option value="">No projects to share</option>
              </Show>
              <For each={projects}>
                {(p) => (
                  <option value={p.id}>
                    {p.name} · {p.commands?.length ?? 0} command
                    {(p.commands?.length ?? 0) === 1 ? '' : 's'}
                  </option>
                )}
              </For>
            </select>
          </Show>

          <Show when={scope() === 'files'}>
            <div class="share-files">
              <Show
                when={files().length > 0}
                fallback={<div class="share-files-empty">No files chosen yet.</div>}
              >
                <ul class="share-file-list">
                  <For each={files()}>
                    {(path) => (
                      <li class="share-file-row">
                        <span class="share-file-name" title={path}>
                          {baseName(path)}
                        </span>
                        <button
                          type="button"
                          class="share-file-remove"
                          title="Remove"
                          disabled={shareBusy()}
                          onClick={() => removeFile(path)}
                        >
                          ✕
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>

              <button
                type="button"
                class="share-file-add"
                disabled={shareBusy() || picking()}
                onClick={() => void pickFiles()}
              >
                {picking() ? 'Choosing…' : '+ Add files…'}
              </button>
            </div>
          </Show>

          {/* Stated rather than assumed: someone sharing "everything" deserves to
              know their secrets are not in it, and someone sending a file
              deserves to know it lands in a folder rather than in the app. */}
          <div class="share-note">
            <Show
              when={scope() === 'files'}
              fallback={
                <>
                  {commandCount()} command{commandCount() === 1 ? '' : 's'} will be sent.
                  Environment variables are never shared.
                </>
              }
            >
              {files().length} file{files().length === 1 ? '' : 's'} will be sent — up to{' '}
              {MAX_FILE_MB} MB each, {MAX_TOTAL_GB} GB in total. They are saved to that
              device's Downloads folder, and nothing on it is overwritten.
            </Show>
          </div>

          {/* Only file transfers report progress — config is small enough that
              a bar would flash and vanish. */}
          <Show when={shareBusy() && sendProgress()}>
            {(p) => (
              <div class="share-progress">
                <div class="share-progress-track">
                  <div
                    class="share-progress-fill"
                    style={{ width: `${percent(p().bytes, p().total)}%` }}
                  />
                </div>
                <div class="share-progress-label">
                  {formatBytes(p().bytes)} of {formatBytes(p().total)}
                </div>
              </div>
            )}
          </Show>

          <Show when={shareError()}>
            <div class="share-error">{shareError()}</div>
          </Show>

          <div class="modal-footer">
            <button class="btn-cancel" disabled={shareBusy()} onClick={close}>
              Cancel
            </button>
            <button class="btn-primary" disabled={!ready()} onClick={() => void send()}>
              {sendLabel()}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}

/**
 * Clamped to 100 so a sender that overshoots its own estimate cannot push the
 * fill past the end of the track.
 */
function percent(bytes: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((bytes / total) * 100));
}

/** Last path segment, for a list that has no room for absolute paths. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Go returns transport errors verbatim, which are accurate but unreadable
 * ("stream reset", "context deadline exceeded"). Map the ones a user can
 * actually act on and pass anything else through rather than swallowing it.
 */
function friendlyError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('older version')) {
    return 'That device is running an older version of yv.';
  }
  // The connection lapsed between connecting and sending — the fix is to start
  // again, which is a different instruction from "they said no".
  if (lower.includes('not connected')) {
    return 'The connection expired. Close this and connect again.';
  }
  if (lower.includes('declined')) return 'They declined the transfer.';
  if (lower.includes('did not answer') || lower.includes('deadline') || lower.includes('timeout')) {
    return 'They did not respond in time.';
  }
  if (lower.includes('reset') || lower.includes('connect') || lower.includes('eof')) {
    return 'Connection lost — that device may have gone offline.';
  }
  return raw;
}
