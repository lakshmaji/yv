import { onCleanup, onMount, Show } from 'solid-js';
import {
  incomingShare,
  setIncomingShare,
  incomingBusy,
  setIncomingBusy,
  incomingResult,
  setIncomingResult,
} from '../../store';
import { go } from '../../wails';

/** How long the merge summary stays up before the modal closes itself. */
const DONE_MS = 2400;

/**
 * Asks whether to accept config another device is offering.
 *
 * This prompt is the real authorization gate. A PIN, if set, only stops a peer
 * from raising this dialog at all — it is this accept that decides whether
 * anything is written to disk, so the default is to decline.
 */
export default function IncomingShareModal() {
  const offer = () => incomingShare();

  let declineRef: HTMLButtonElement | undefined;
  let doneTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    // Decline takes the focus, so a stray Return or Space does not import
    // someone else's config.
    declineRef?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !incomingBusy()) {
        e.preventDefault();
        void respond(false);
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
    setIncomingShare(null);
    setIncomingBusy(false);
    setIncomingResult(null);
  }

  async function respond(accept: boolean): Promise<void> {
    const cur = offer();
    if (!cur || incomingBusy()) return;

    setIncomingBusy(true);
    try {
      await go.RespondToShare(cur.transferId, accept);
    } catch {
      // The sender is gone; there is nothing left to accept either way.
      close();
      return;
    }

    if (!accept) {
      close();
      return;
    }
    // On acceptance the modal stays up: the share:imported event carries the
    // merge summary, and closing before it arrives would hide the outcome.
    doneTimer = setTimeout(close, DONE_MS + 8000);
  }

  /** What they are offering, in words rather than a scope enum. */
  const description = () => {
    const cur = offer();
    if (!cur) return '';
    if (cur.scope === 'app') {
      const n = cur.projectCount;
      return `their entire setup — ${n} project${n === 1 ? '' : 's'}`;
    }
    return `the project "${cur.projectName ?? 'untitled'}"`;
  };

  return (
    <div class="modal-overlay">
      <div class="modal-box share-modal">
        <Show when={incomingResult()}>
          <div class="modal-title">Received from {offer()?.fromName}</div>
          <div class="share-done">✓ {incomingResult()}</div>
          <div class="modal-footer">
            <button class="btn-primary" onClick={close}>
              Done
            </button>
          </div>
        </Show>

        <Show when={!incomingResult()}>
          <div class="modal-title">{offer()?.fromName} wants to share</div>

          <div class="share-incoming-body">
            <span class="share-incoming-what">
              They are offering {description()}.
            </span>
            {/* Says what accepting does, in the terms the existing import uses,
                so nobody has to guess whether this overwrites their work. */}
            <span class="share-hint">
              Projects you do not already have will be added. Anything with a
              matching project is left alone, and your environment variables are
              not touched.
            </span>
          </div>

          <div class="modal-footer">
            <button
              ref={declineRef}
              class="btn-cancel"
              disabled={incomingBusy()}
              onClick={() => void respond(false)}
            >
              Decline
            </button>
            <button
              class="btn-primary"
              disabled={incomingBusy()}
              onClick={() => void respond(true)}
            >
              {incomingBusy() ? 'Receiving…' : 'Accept'}
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
