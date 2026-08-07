import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { sharePeer, pinAccepted, resetShareState } from '../../store';
import { go } from '../../wails';

/**
 * Step one of sharing: prove to the other device that a person here is asking.
 *
 * A code is generated on this machine and shown large. The user reads it out —
 * on the phone, in a chat, across the desk — and the other person types it into
 * the prompt that has appeared on their screen. Only the hash of it goes over
 * the wire, so their device cannot show it to them; being told is the only way
 * they can have it, and that is exactly what the step is for.
 *
 * Every peer goes through this. There is no setting that turns it off, because
 * a lock people can quietly leave open is one that is quietly left open.
 */
export default function PeerConnectModal() {
  const peer = () => sharePeer();

  const [code, setCode] = createSignal('');
  const [waiting, setWaiting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Set once the component is torn down, so a connect call that returns after
  // the user has cancelled does not push them into the transfer dialog.
  let dead = false;

  onMount(() => {
    void begin();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resetShareState();
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => {
      dead = true;
      window.removeEventListener('keydown', onKey);
    });
  });

  async function begin(): Promise<void> {
    const target = peer();
    if (!target) return;

    setError(null);
    try {
      // Generated locally, so it is on screen immediately — the other person is
      // usually already waiting to be told it.
      const fresh = await go.NewConnectionCode();
      if (dead) return;
      if (!fresh) {
        setError('Could not generate a code.');
        return;
      }
      setCode(fresh);
      setWaiting(true);

      // Blocks until they type it, decline, or run out of time.
      const res = await go.ConnectToPeer(target.id, fresh);
      if (dead) return;

      if (res.startsWith('error:')) {
        setError(friendlyError(res.slice(6).trim()));
        return;
      }
      pinAccepted(fresh);
    } catch (e) {
      if (!dead) setError(friendlyError(String(e)));
    } finally {
      if (!dead) setWaiting(false);
    }
  }

  function onOverlayClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) resetShareState();
  }

  return (
    <div class="modal-overlay" onClick={onOverlayClick}>
      <div class="modal-box share-modal connect-modal">
        <div class="modal-title">Connect to {peer()?.name}</div>

        <div class="share-hint">
          Read this code to whoever is at {peer()?.name}. They type it there to let you in.
        </div>

        <Show when={code()} fallback={<div class="connect-code loading">••••••••</div>}>
          {/* Split into two groups of four: eight unbroken characters are read
              back wrongly far more often than 4 + 4. */}
          <div class="connect-code">
            <span>{code().slice(0, 4)}</span>
            <span>{code().slice(4)}</span>
          </div>
        </Show>

        <Show when={waiting() && !error()}>
          <div class="connect-waiting">
            <span class="connect-spinner" />
            Waiting for them to enter it…
          </div>
        </Show>

        <Show when={error()}>
          <div class="share-error">{error()}</div>
        </Show>

        <div class="modal-footer">
          <button class="btn-cancel" onClick={resetShareState}>
            Cancel
          </button>
          {/* A new attempt draws a new code: the old one has been read out by
              now, and reusing it after a refusal would be the wrong lesson. */}
          <Show when={error()}>
            <button class="btn-primary" onClick={() => void begin()}>
              Try again
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}

/**
 * The far end does not say whether it was declined or mistyped — that is its
 * user's business — but it does distinguish "refused" from "never answered",
 * because those call for different things from the person waiting here.
 */
function friendlyError(raw: string): string {
  const lower = raw.toLowerCase();
  // Checked before the generic transport cases: an old peer's dial failure
  // mentions "protocol", which would otherwise be read as a lost connection.
  if (lower.includes('older version')) {
    return 'That device is running an older version of yv. Update it and restart both.';
  }
  // "Nobody answered" and "they said no" are different things to be told, and
  // only one of them is worth trying again.
  if (lower.includes('did not answer')) {
    return 'No answer yet — they have not typed the code.';
  }
  if (lower.includes('declined')) return 'They declined the connection.';
  if (lower.includes('discovery is not running')) {
    return 'Discovery is not running on this device.';
  }
  if (lower.includes('deadline') || lower.includes('timeout')) {
    return 'They did not answer in time.';
  }
  if (lower.includes('reset') || lower.includes('connect') || lower.includes('eof')) {
    return 'Connection lost — that device may have gone offline.';
  }
  return raw;
}
