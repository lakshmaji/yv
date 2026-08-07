import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { incomingConnect, setIncomingConnect } from '../../store';
import { go } from '../../wails';

/**
 * The other half of the connection step: someone nearby is asking to connect,
 * and the only way in is a code they have to tell you.
 *
 * This device never learns the code — only its hash arrives — so there is
 * nothing here to read off the screen and nothing to leak. Typing it is the
 * proof that a real conversation happened, which is what a stranger on the same
 * network cannot produce however many times they ask.
 *
 * Accepting only opens a conversation. Anything they then send is still offered
 * separately, and still has to be accepted on its own terms.
 */
export default function IncomingConnectModal() {
  const req = () => incomingConnect();

  const [code, setCode] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [remaining, setRemaining] = createSignal<number | null>(null);

  let inputRef: HTMLInputElement | undefined;

  const ready = () => !busy() && code().trim().length > 0;

  onMount(() => {
    inputRef?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy()) {
        e.preventDefault();
        void decline();
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  async function submit(): Promise<void> {
    const cur = req();
    if (!cur || !ready()) return;

    setError(null);
    setBusy(true);
    try {
      const res = await go.AnswerConnectRequest(cur.requestId, code().trim());
      if (res === 'ok') {
        setIncomingConnect(null);
        return;
      }
      if (res === 'expired') {
        setError('That request is no longer waiting.');
        return;
      }
      // "wrong: N" — N attempts left before the request is dropped.
      const left = Number(res.split(':')[1] ?? 0);
      setRemaining(left);
      if (left <= 0) {
        setError('Too many wrong codes. Ask them to try connecting again.');
        return;
      }
      setError(`That code does not match. ${left} attempt${left === 1 ? '' : 's'} left.`);
      inputRef?.select();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function decline(): Promise<void> {
    const cur = req();
    if (!cur) return;
    setBusy(true);
    try {
      await go.DeclineConnectRequest(cur.requestId);
    } catch {
      // They are gone; there is nothing left to decline either way.
    }
    setIncomingConnect(null);
  }

  return (
    <div class="modal-overlay">
      <div class="modal-box share-modal connect-modal">
        <div class="modal-title">{req()?.fromName} wants to connect</div>

        <div class="share-hint">
          They have a code on their screen. Ask them for it — connecting lets them offer you
          a project or files, and you will still be asked before anything is saved.
        </div>

        <input
          ref={inputRef}
          class="connect-code-input"
          classList={{ 'input-error': !!error() }}
          autocomplete="off"
          autocapitalize="characters"
          spellcheck={false}
          maxlength={12}
          placeholder="ABCD2345"
          value={code()}
          disabled={busy() || remaining() === 0}
          onInput={(e) => {
            // Upper-cased as they type: the codes are generated in upper case
            // and matched case-insensitively, so this only removes a way for the
            // field to look wrong while being right.
            setCode(e.currentTarget.value.toUpperCase());
            if (error()) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready()) void submit();
          }}
        />

        <Show when={error()}>
          <div class="share-error">{error()}</div>
        </Show>

        <div class="modal-footer">
          {/* Decline takes the focus order first, as on the transfer prompt:
              the safe answer should never be the one you reach by accident. */}
          <button class="btn-cancel" disabled={busy()} onClick={() => void decline()}>
            Decline
          </button>
          <button
            class="btn-primary"
            disabled={!ready() || remaining() === 0}
            onClick={() => void submit()}
          >
            {busy() ? 'Checking…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
