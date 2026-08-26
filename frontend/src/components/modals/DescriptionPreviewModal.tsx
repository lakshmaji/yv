import { Show, createEffect } from 'solid-js';
import { selectedProject, previewingCmd, setPreviewingCmd } from '../../store';
import { renderMarkdown } from '../../lib/markdown';

export default function DescriptionPreviewModal() {
  const cmd = () => {
    const proj = selectedProject();
    const id = previewingCmd();
    if (!proj || !id) return null;
    return proj.commands.find(c => c.id === id) || null;
  };

  function close() {
    setPreviewingCmd(null);
  }

  // Switching the selected project, or a config reload that drops this
  // command, leaves previewingCmd pointing at nothing — cmd() goes null and
  // <Show> hides the modal, but without this the id (and anyModalOpen())
  // would stay stuck until something else happened to clear it.
  createEffect(() => {
    if (previewingCmd() && !cmd()) setPreviewingCmd(null);
  });

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  return (
    <Show when={cmd()}>
      {(c) => (
        <div class="modal-overlay" onClick={handleOverlayClick}>
          <div class="modal-box description-preview-box">
            <div class="modal-title">{c().label}</div>
            <div class="modal-body description-preview-body" innerHTML={renderMarkdown(c().description || '')} />
            <div class="modal-footer">
              <button class="btn-cancel" onClick={close}>Close</button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
