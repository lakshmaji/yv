import { Show, createResource } from 'solid-js';
import { aboutModalOpen, setAboutModalOpen, setUpdateModalOpen } from '../../store';
import { go, runtime } from '../../wails';

const REPO_URL = 'https://github.com/lakshmaji/yv';
const ISSUES_URL = 'https://github.com/lakshmaji/yv/issues';
const PROFILE_URL = 'https://github.com/lakshmaji';

export default function AboutModal() {
  // Fetched once for the life of the app rather than on every open: the version
  // is fixed at link time and cannot change while the process is running.
  const [version] = createResource(() => go.GetAppVersion());

  function close() {
    setAboutModalOpen(false);
  }

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  // Links are buttons, not anchors: an <a href> in the Wails webview navigates
  // the app window away from itself rather than handing off to the browser.
  function open(url: string) {
    runtime.BrowserOpenURL(url);
  }

  // About closes: two stacked dialogs with two Close buttons is a worse answer
  // than one, and there is nothing left to read here once the update dialog is
  // up.
  function checkForUpdates() {
    close();
    setUpdateModalOpen(true);
    go.CheckForUpdates();
  }

  return (
    <Show when={aboutModalOpen()}>
      <div class="modal-overlay" onClick={handleOverlayClick}>
        <div class="modal-box about-modal">
          <div class="kb-header">
            <div class="modal-title">About yv</div>
            <button class="kb-close" onClick={close} title="Close">✕</button>
          </div>

          <p class="about-lead">
            A local dev command runner. Create projects, share, attach shell commands, manage environment and
            run them with live streaming output.
          </p>

          <div class="about-meta">
            <span class="about-version">{version() ?? '…'}</span>
            <span class="about-dot">·</span>
            <button class="about-link" onClick={() => open(`${REPO_URL}/blob/main/LICENSE`)}>
              MIT licensed
            </button>
            <span class="about-dot">·</span>
            <span>© 2026 Lakshmaji</span>
            <span class="about-dot">·</span>
            {/* Hands off to the update dialog rather than reporting inline:
                the answer can be a download with release notes and a progress
                bar, none of which belongs in a line of metadata. */}
            <button class="about-link" onClick={checkForUpdates}>
              Check for updates
            </button>
          </div>

          <div class="about-note">
            <div class="about-note-title">★ Enjoying yv?</div>
            <p>
              A star helps other developers find it — it is the only thing this
              project asks for.
            </p>
            <button class="btn-primary about-star" onClick={() => open(REPO_URL)}>
              Star on GitHub
            </button>
          </div>

          <div class="about-note">
            <div class="about-note-title">More tools on the way</div>
            <p>
              yv is one of several tools being built and shared openly. Follow along
              on GitHub for the rest.
            </p>
          </div>

          <div class="about-note">
            <div class="about-note-title">Open to volunteering</div>
            <p>
              Available to contribute, to software and apps that help
              people — non-profits especially. Reach out on GitHub.
            </p>
            <button class="about-link" onClick={() => open(PROFILE_URL)}>
              github.com/lakshmaji
            </button>
          </div>

          <div class="modal-footer">
            <button class="btn-cancel" onClick={() => open(ISSUES_URL)}>
              Report an issue
            </button>
            <button class="btn-cancel" onClick={close}>Close</button>
          </div>
        </div>
      </div>
    </Show>
  );
}
