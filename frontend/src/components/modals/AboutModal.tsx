import { Show } from 'solid-js';
import { aboutModalOpen, setAboutModalOpen } from '../../store';
import { runtime } from '../../wails';

const REPO_URL = 'https://github.com/lakshmaji/yv';
const ISSUES_URL = 'https://github.com/lakshmaji/yv/issues';
const PROFILE_URL = 'https://github.com/lakshmaji';

export default function AboutModal() {
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
            <button class="about-link" onClick={() => open(`${REPO_URL}/blob/main/LICENSE`)}>
              MIT licensed
            </button>
            <span class="about-dot">·</span>
            <span>© 2026 Lakshmaji</span>
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
