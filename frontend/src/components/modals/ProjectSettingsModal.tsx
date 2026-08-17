import { Show, createSignal, createEffect, For } from 'solid-js';
import { projects, setProjects, settingsProjectId, setSettingsProjectId, setSelectedId } from '../../store';
import { go } from '../../wails';
import { ENV_BG_PRESETS, ENV_TEXT_PRESETS } from '../../lib/envColors';

export default function ProjectSettingsModal() {
  const [name, setName] = createSignal('');
  const [dir, setDir] = createSignal('');
  const [labelBgColor, setLabelBgColor] = createSignal('');
  const [labelTxColor, setLabelTxColor] = createSignal('');
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);

  const project = () => {
    const id = settingsProjectId();
    return id ? projects.find(p => p.id === id) || null : null;
  };

  createEffect(() => {
    const p = project();
    if (p) {
      setName(p.name || '');
      setDir(p.workingDir || '');
      setLabelBgColor(p.labelBgColor || '');
      setLabelTxColor(p.labelTxColor || '');
    }
  });

  function close() {
    setConfirmingDelete(false);
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
    const result = await go.UpdateProject(id, n, d, labelBgColor(), labelTxColor());
    if (result !== 'ok') { alert('Save failed: ' + result); return; }
    setProjects(await go.LoadProjects() as any);
    close();
  }

  async function handleBrowse() {
    const picked = await go.PickFolder();
    if (picked) setDir(picked);
  }

  async function handleDelete() {
    const p = project();
    if (!p) return;
    const id = p.id;
    const filtered = projects.filter(pr => pr.id !== id);
    setProjects(filtered as any);
    await go.SaveProjects(filtered as any);
    await go.DeleteEnvironments(id);
    close();
    setSelectedId(filtered[0]?.id ?? null);
  }

  async function handleExport() {
    const id = settingsProjectId();
    if (!id) return;
    try {
      const path = await go.ExportProject(id);
      if (path) alert('Exported to ' + path);
    } catch (err) { alert('Export failed: ' + err); }
  }

  const previewStyle = () => {
    const bg = labelBgColor();
    const tx = labelTxColor();
    const style: Record<string, string> = {};
    if (bg) { style['background'] = bg; style['border-color'] = bg; }
    if (tx) style['color'] = tx;
    return style;
  };

  const initials = () => name().trim().slice(0, 2).toUpperCase() || '??';

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

          <div class="modal-field-label">Label Colour</div>
          <div class="proj-color-section">
            <div class="proj-color-preview-wrap">
              <div class="project-avatar proj-color-preview" style={previewStyle()}>
                {initials()}
              </div>
              <span class="proj-color-preview-hint">Preview</span>
            </div>
            <div class="proj-color-pickers">
              <div class="proj-color-group">
                <span class="proj-color-group-label">Background</span>
                <div class="proj-color-swatches">
                  <For each={ENV_BG_PRESETS}>
                    {preset => (
                      <button
                        type="button"
                        class="proj-color-swatch"
                        classList={{ selected: labelBgColor() === preset.value }}
                        title={preset.name}
                        style={preset.value ? { background: preset.value, 'border-color': preset.value } : {}}
                        onClick={() => setLabelBgColor(preset.value)}
                      >
                        {!preset.value && <span class="swatch-none">∅</span>}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <div class="proj-color-group">
                <span class="proj-color-group-label">Text</span>
                <div class="proj-color-swatches">
                  <For each={ENV_TEXT_PRESETS}>
                    {preset => (
                      <button
                        type="button"
                        class="proj-color-swatch"
                        classList={{ selected: labelTxColor() === preset.value }}
                        title={preset.name}
                        style={preset.value ? { background: preset.value, 'border-color': preset.value } : {}}
                        onClick={() => setLabelTxColor(preset.value)}
                      >
                        {!preset.value && <span class="swatch-none">∅</span>}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </div>

          <div class="project-settings-export">
            <div class="project-settings-export-label">Export Project</div>
            <div class="project-settings-export-hint">
              Commit the file to this project's repository and yv can find it again.
            </div>
            <div class="project-settings-export-btns">
              <button onClick={handleExport}>↑ Export as yv.yaml</button>
            </div>
          </div>
          <div class="danger-zone">
            <Show when={!confirmingDelete()}>
              <button class="btn-danger" onClick={() => setConfirmingDelete(true)}>Delete Project</button>
            </Show>
            <Show when={confirmingDelete()}>
              <div class="delete-confirm-row">
                <span class="delete-confirm-label">Delete project "{project()?.name}"?</span>
                <button class="btn-cancel" onClick={() => setConfirmingDelete(false)}>Cancel</button>
                <button class="btn-danger" onClick={handleDelete}>Yes, delete</button>
              </div>
            </Show>
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
