import { Show, createMemo } from 'solid-js';
import {
  updateModalOpen,
  setUpdateModalOpen,
  updateState,
  updateBusy,
} from '../../store';
import { go } from '../../wails';
import { formatBytes } from '../../lib/utils';
import { formatReleaseNotes } from '../../lib/releaseNotes';

/**
 * One dialog, one screen per status.
 *
 * Every screen is driven from `updateState()`, which Go owns end to end — the
 * dialog holds no state of its own beyond whether it is open. That is what
 * makes it safe to close mid-download and reopen: the progress bar picks up
 * where it is rather than where this component last saw it.
 *
 * Deliberately not a native MessageDialog. Release notes need to be scrollable
 * and a progress bar needs to be redrawn, neither of which a system alert does.
 */
export default function UpdateModal() {
  const state = updateState;

  function close() {
    setUpdateModalOpen(false);
  }

  function handleOverlayClick(e: MouseEvent) {
    // A download keeps running when this is dismissed — Go owns it, not the
    // dialog — so an accidental click costs nothing but the view of it.
    if (e.target === e.currentTarget) close();
  }

  const percent = createMemo(() => {
    const { downloaded = 0, total = 0 } = state();
    if (!total) return null; // no published size: indeterminate, not a made-up number
    return Math.min(100, Math.round((downloaded / total) * 100));
  });

  const progressLabel = createMemo(() => {
    const { downloaded = 0, total = 0 } = state();
    if (!total) return formatBytes(downloaded);
    return `${formatBytes(downloaded)} of ${formatBytes(total)}`;
  });

  return (
    <Show when={updateModalOpen()}>
      <div class="modal-overlay" onClick={handleOverlayClick}>
        <div class="modal-box update-modal">
          <div class="kb-header">
            <div class="modal-title">Software Update</div>
            <button class="kb-close" onClick={close} title="Close">✕</button>
          </div>

          <div class="update-current">
            You are running <span class="about-version">{state().current || '…'}</span>
          </div>

          {/* Checking */}
          <Show when={state().status === 'checking'}>
            <p class="update-lead">Checking for updates…</p>
          </Show>

          {/* Up to date, dev build, or a failure — all one line of explanation */}
          <Show when={['current', 'dev', 'failed'].includes(state().status)}>
            <p class="update-lead" classList={{ 'update-problem': state().status === 'failed' }}>
              {state().message}
            </p>
          </Show>

          {/* Something is available */}
          <Show when={['available', 'manual', 'downloading', 'ready'].includes(state().status)}>
            <div class="update-version-row">
              <span class="update-new-version">{state().version}</span>
              <span class="update-version-note">is available</span>
            </div>

            <Show when={state().notes}>
              {/* Written by whoever authored the changeset, so it is worth
                  showing in full rather than truncating to a line — stripped of
                  the markdown syntax nobody is reading the source of, and
                  rendered as text, never as markup. */}
              <div class="update-notes">{formatReleaseNotes(state().notes || '')}</div>
            </Show>
          </Show>

          {/* This install cannot replace itself: a .deb, a tarball, a bundle
              macOS translocated, or a build with no signing key. The reason is
              the actionable part, so it is not hidden behind the button. */}
          <Show when={state().status === 'manual'}>
            <p class="update-lead update-problem">{state().message}</p>
          </Show>

          {/* Downloading */}
          <Show when={state().status === 'downloading'}>
            <div class="share-progress">
              <div class="share-progress-track">
                <div
                  class="share-progress-fill"
                  classList={{ 'update-progress-indeterminate': percent() === null }}
                  style={{ width: percent() === null ? '100%' : `${percent()}%` }}
                />
              </div>
              <div class="share-progress-label">{progressLabel()}</div>
            </div>
          </Show>

          {/* Downloaded and verified */}
          <Show when={state().status === 'ready'}>
            <p class="update-lead">
              Downloaded and verified. yv will restart to finish installing.
            </p>
          </Show>

          <div class="modal-footer">
            <Show when={state().status === 'manual'}>
              <button class="btn-primary" onClick={() => go.OpenReleasePage()}>
                Open downloads page
              </button>
            </Show>

            <Show when={state().status === 'available'}>
              <button class="btn-primary" onClick={() => go.DownloadUpdate()}>
                Download
              </button>
            </Show>

            <Show when={state().status === 'ready'}>
              <button class="btn-primary" onClick={() => go.RestartToUpdate()}>
                Restart now
              </button>
            </Show>

            <Show when={['current', 'failed', 'dev', 'idle'].includes(state().status)}>
              <button
                class="btn-primary"
                disabled={updateBusy()}
                onClick={() => go.CheckForUpdates()}
              >
                Check again
              </button>
            </Show>

            <button class="btn-cancel" onClick={close}>
              {/* "Later" while there is something pending, because the download
                  survives this dialog and the wording should not suggest it is
                  being abandoned. */}
              {state().status === 'ready' || state().status === 'downloading' ? 'Later' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
