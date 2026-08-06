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
  resetShareState,
} from '../../store';
import { go } from '../../wails';
import type { ShareScope } from '../../types';

/** How long a success message stays up before the modal closes itself. */
const DONE_MS = 1600;

/**
 * Sends config to the peer whose dinosaur was tapped.
 *
 * Environments are never included — secrets live in their own file precisely so
 * they do not travel with shared config — and the receiver still has to accept,
 * so nothing here can push config onto another machine unattended.
 */
export default function ShareModal() {
  const peer = () => sharePeer();

  const [scope, setScope] = createSignal<ShareScope>('project');
  const [projectId, setProjectId] = createSignal(selectedId() ?? '');
  const [pin, setPin] = createSignal('');

  let pinRef: HTMLInputElement | undefined;
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
    if (peer()?.pinRequired && pin().trim().length === 0) return false;
    return true;
  };

  onMount(() => {
    // The PIN is the only thing the user has to type, so it takes the focus.
    if (peer()?.pinRequired) pinRef?.focus();

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

  async function send(): Promise<void> {
    const target = peer();
    if (!target || !ready()) return;

    setShareError(null);
    setShareBusy(true);

    try {
      const res = await go.InitiateShare(target.id, scope(), projectId(), pin().trim());
      if (res.startsWith('error:')) {
        setShareError(friendlyError(res.slice(6).trim()));
        return;
      }
      // Go only returns ok once the receiver confirmed it applied the payload,
      // so this genuinely means "landed", not "sent".
      setShareDone(
        scope() === 'app'
          ? `Sent ${projects.length} project${projects.length === 1 ? '' : 's'} to ${target.name}`
          : `Sent ${chosenProject()?.name ?? 'project'} to ${target.name}`,
      );
      doneTimer = setTimeout(close, DONE_MS);
    } catch (e) {
      setShareError(friendlyError(String(e)));
    } finally {
      setShareBusy(false);
    }
  }

  const isPinError = () => (shareError() ?? '').toLowerCase().includes('pin');

  return (
    <div class="modal-overlay" onClick={onOverlayClick}>
      <div class="modal-box share-modal">
        <div class="modal-title">Share with {peer()?.name}</div>

        <Show when={shareDone()}>
          <div class="share-done">✓ {shareDone()}</div>
        </Show>

        <Show when={!shareDone()}>
          <Show when={peer()?.pinRequired}>
            <div class="modal-field-label">PIN</div>
            <input
              ref={pinRef}
              class="share-pin-input"
              classList={{ 'input-error': isPinError() }}
              inputmode="numeric"
              autocomplete="off"
              placeholder="Code shown on that device"
              value={pin()}
              disabled={shareBusy()}
              onInput={(e) => {
                setPin(e.currentTarget.value);
                if (shareError()) setShareError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ready()) void send();
              }}
            />
            <div class="share-hint">
              {peer()?.name} asks for a PIN. It is set in that device's Settings.
            </div>
          </Show>

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

          {/* Stated rather than assumed: someone sharing "everything" deserves to
              know their secrets are not in it. */}
          <div class="share-note">
            {commandCount()} command{commandCount() === 1 ? '' : 's'} will be sent. Environment
            variables are never shared.
          </div>

          <Show when={shareError()}>
            <div class="share-error">{shareError()}</div>
          </Show>

          <div class="modal-footer">
            <button class="btn-cancel" disabled={shareBusy()} onClick={close}>
              Cancel
            </button>
            <button class="btn-primary" disabled={!ready()} onClick={() => void send()}>
              {shareBusy() ? 'Waiting for them to accept…' : 'Send'}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}

/**
 * Go returns transport errors verbatim, which are accurate but unreadable
 * ("stream reset", "context deadline exceeded"). Map the ones a user can
 * actually act on and pass anything else through rather than swallowing it.
 */
function friendlyError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('incorrect pin')) return 'Incorrect PIN — check the code on that device.';
  if (lower.includes('declined')) return 'They declined the transfer.';
  if (lower.includes('deadline') || lower.includes('timeout')) {
    return 'They did not respond in time.';
  }
  if (lower.includes('reset') || lower.includes('connect') || lower.includes('eof')) {
    return 'Connection lost — that device may have gone offline.';
  }
  return raw;
}
