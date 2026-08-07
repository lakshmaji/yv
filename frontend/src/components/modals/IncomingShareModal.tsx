import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import {
  incomingShare,
  setIncomingShare,
  incomingBusy,
  setIncomingBusy,
  incomingResult,
  setIncomingResult,
  incomingError,
  setIncomingError,
  recvProgress,
  setRecvProgress,
} from '../../store';
import { go } from '../../wails';
import { formatBytes } from '../../lib/utils';

/**
 * Asks whether to accept config another device is offering.
 *
 * This prompt is the real authorization gate. A PIN, if set, only stops a peer
 * from raising this dialog at all — it is this accept that decides whether
 * anything is written to disk, so the default is to decline.
 */
export default function IncomingShareModal() {
  const offer = () => incomingShare();

  // Set if opening the folder fails, which is the only way the user would learn
  // that clicking the button did nothing.
  const [openFailed, setOpenFailed] = createSignal(false);

  let declineRef: HTMLButtonElement | undefined;

  onMount(() => {
    // Decline takes the focus, so a stray Return or Space does not import
    // someone else's config.
    declineRef?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || incomingBusy()) return;
      e.preventDefault();
      // Once there is a result, Escape dismisses rather than declines — there is
      // nothing left to refuse, and the transfer has already happened.
      if (incomingResult() || incomingError()) {
        close();
        return;
      }
      void respond(false);
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  function close(): void {
    setIncomingShare(null);
    setIncomingBusy(false);
    setIncomingResult(null);
    setIncomingError(null);
    setRecvProgress(null);
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

    // On acceptance the modal stays up until the user dismisses it. Nothing
    // closes it on a timer: the summary says where files landed, and a dialog
    // that vanishes on its own takes that away from anyone who looked up.
    if (!accept) close();
  }

  async function showFolder(): Promise<void> {
    setOpenFailed(false);
    try {
      const res = await go.ShowReceivedFiles();
      if (res.startsWith('error:')) setOpenFailed(true);
    } catch {
      setOpenFailed(true);
    }
  }

  /** What they are offering, in words rather than a scope enum. */
  const description = () => {
    const cur = offer();
    if (!cur) return '';
    if (cur.scope === 'files') {
      const n = cur.fileNames?.length ?? 0;
      const size = cur.totalBytes ? ` (${formatBytes(cur.totalBytes)})` : '';
      return `${n} file${n === 1 ? '' : 's'}${size}`;
    }
    if (cur.scope === 'app') {
      const n = cur.projectCount;
      return `their entire setup — ${n} project${n === 1 ? '' : 's'}`;
    }
    return `the project "${cur.projectName ?? 'untitled'}"`;
  };

  const isFiles = () => offer()?.scope === 'files';

  return (
    <div class="modal-overlay">
      <div class="modal-box share-modal">
        <Show when={incomingResult()}>
          <div class="modal-title">Received from {offer()?.fromName}</div>
          <div class="share-done">✓ {incomingResult()}</div>

          <Show when={openFailed()}>
            <div class="share-hint">
              Could not open the folder — the path is above.
            </div>
          </Show>

          <div class="modal-footer">
            {/* Only for files: a config share lands in the app, so there is no
                folder to show. */}
            <Show when={isFiles()}>
              <button class="btn-cancel" onClick={() => void showFolder()}>
                Show downloaded folder
              </button>
            </Show>
            <button class="btn-primary" onClick={close}>
              Done
            </button>
          </div>
        </Show>

        <Show when={incomingError()}>
          <div class="modal-title">Transfer from {offer()?.fromName} failed</div>
          <div class="share-error">{incomingError()}</div>
          <div class="modal-footer">
            <button class="btn-primary" onClick={close}>
              Close
            </button>
          </div>
        </Show>

        <Show when={!incomingResult() && !incomingError()}>
          <div class="modal-title">{offer()?.fromName} wants to share</div>

          <div class="share-incoming-body">
            <span class="share-incoming-what">
              They are offering {description()}.
            </span>

            {/* Files are named, not just counted: a filename is the only thing
                that tells the receiver whether this is the thing they were
                expecting or something they should decline. */}
            <Show when={isFiles() && (offer()?.fileNames?.length ?? 0) > 0}>
              <ul class="share-file-list share-incoming-files">
                <For each={offer()?.fileNames}>
                  {(name) => <li class="share-file-row">{name}</li>}
                </For>
              </ul>
            </Show>

            {/* Says what accepting does, in the terms the existing import uses,
                so nobody has to guess whether this overwrites their work. */}
            <Show
              when={isFiles()}
              fallback={
                <span class="share-hint">
                  Projects you do not already have will be added. Anything with a
                  matching project is left alone, and your environment variables
                  are not touched.
                </span>
              }
            >
              <span class="share-hint">
                Files are saved into a yv-received folder in your Downloads. Nothing
                you already have is overwritten, and nothing is run.
              </span>
            </Show>
          </div>

          <Show when={incomingBusy() && recvProgress()}>
            {(p) => (
              <div class="share-progress">
                <div class="share-progress-track">
                  <div
                    class="share-progress-fill"
                    style={{
                      width: `${p().total > 0 ? Math.min(100, Math.round((p().bytes / p().total) * 100)) : 0}%`,
                    }}
                  />
                </div>
                <div class="share-progress-label">
                  {formatBytes(p().bytes)} of {formatBytes(p().total)}
                </div>
              </div>
            )}
          </Show>

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
