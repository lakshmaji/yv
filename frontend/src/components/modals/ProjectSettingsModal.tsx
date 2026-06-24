import { Show, createSignal, createEffect } from 'solid-js';
import { projects, setProjects, settingsProjectId, setSettingsProjectId } from '../../store';
import { go } from '../../wails';

export default function ProjectSettingsModal() {
  const [name, setName] = createSignal('');
  const [dir, setDir] = createSignal('');

  const project = () => {
    const id = settingsProjectId();
    return id ? projects.find(p => p.id === id) || null : null;
  };

  createEffect(() => {
    const p = project();
    if (p) {
      setName(p.name || '');
      setDir(p.workingDir || '');
    }
  });

  function close() {
    setSettingsProjectId(null);
  }

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  async function handleSave() {
    const id = settingsProjectId();
    if (!id) return;
    const n = name().trim();
    const d = dir().trim();
    if (!n) return;
    const result = await go.UpdateProject(id, n, d);
    if (result !== 'ok') { alert('Save failed: ' + result); return; }
    setProjects(await go.LoadProjects() as any);
    close();
  }

  async function handleBrowse() {
    const picked = await go.PickFolder();
    if (picked) setDir(picked);
  }

  async function handleExport(format: string) {
    const id = settingsProjectId();
    if (!id) return;
    try {
      const path = await go.ExportProject(id, format);
      if (path) alert('Exported to ' + path);
    } catch (err) { alert('Export failed: ' + err); }
  }

  return (
    <Show when={settingsProjectId()}>
      <div class="modal-overlay" onClick={handleOverlayClick}>
        <div class="modal-box">
          <div class="modal-title">Project Settings</div>
          <div class="modal-field-label">Name</div>
          <input
            placeholder="Project name"
            value={name()}
            onInput={e => setName(e.currentTarget.value)}
          />
          <div class="modal-field-label">Folder Path</div>
          <div class="add-cmd-dir-row">
            <input
              placeholder="Folder path"
              value={dir()}
              onInput={e => setDir(e.currentTarget.value)}
              style={{ "font-family": "var(--mono)", "font-size": "12px" }}
            />
            <button class="add-cmd-dir-pick" type="button" onClick={handleBrowse}>Browse</button>
          </div>
          <div class="project-settings-export">
            <div class="project-settings-export-label">Export Project</div>
            <div class="project-settings-export-btns">
              <button onClick={() => handleExport('json')}>↑ Export as JSON</button>
              <button onClick={() => handleExport('yaml')}>↑ Export as YAML</button>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-cancel" onClick={close}>Cancel</button>
            <button class="btn-primary" onClick={handleSave}>Save</button>
          </div>
        </div>
      </div>
    </Show>
  );
}
