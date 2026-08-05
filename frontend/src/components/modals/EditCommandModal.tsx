import { Show, Index, createSignal, createEffect } from 'solid-js';
import { projects, setProjects, selectedProject, selectedId, editingCmd, setEditingCmd } from '../../store';
import { go } from '../../wails';
import type { CommandConfig, PostCommand } from '../../types';

export default function EditCommandModal() {
  const [label, setLabel] = createSignal('');
  const [group, setGroup] = createSignal('');
  const [command, setCommand] = createSignal('');
  const [workingDir, setWorkingDir] = createSignal('');
  const [interactive, setInteractive] = createSignal(false);
  const [preHooks, setPreHooks] = createSignal<string[]>([]);
  const [postHooks, setPostHooks] = createSignal<{ command: string; timeout: string }[]>([]);
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);

  const cmd = (): CommandConfig | null => {
    const proj = selectedProject();
    const id = editingCmd();
    if (!proj || !id) return null;
    return proj.commands.find(c => c.id === id) || null;
  };

  createEffect(() => {
    const c = cmd();
    if (c) {
      setLabel(c.label || '');
      setGroup(c.group || '');
      setCommand(c.command || '');
      setWorkingDir(c.workingDir || '');
      setInteractive(c.interactive || false);
      setPreHooks(c.preCommands ? [...c.preCommands] : []);
      setPostHooks(
        c.postCommands
          ? c.postCommands.map(p => ({ command: p.command, timeout: p.timeout ? String(p.timeout) : '' }))
          : []
      );
    }
  });

  function close() {
    setConfirmingDelete(false);
    setEditingCmd(null);
  }

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  async function handleSave() {
    const c = cmd();
    if (!c) return;
    const l = label().trim();
    const co = command().trim();
    if (!l || !co) return;

    const projIdx = projects.findIndex(p => p.id === selectedId());
    if (projIdx === -1) return;
    const cmdIdx = projects[projIdx].commands.findIndex(cm => cm.id === c.id);
    if (cmdIdx === -1) return;

    setProjects(projIdx, 'commands', cmdIdx, {
      label: l,
      group: group().trim(),
      command: co,
      workingDir: workingDir().trim(),
      interactive: interactive(),
      preCommands: preHooks().filter(h => h.trim()),
      postCommands: postHooks()
        .filter(h => h.command.trim())
        .map(h => ({
          command: h.command.trim(),
          timeout: h.timeout ? parseInt(h.timeout, 10) || 0 : 0,
        })),
    });

    const result = await go.SaveProjects(projects as any);
    if (result !== 'ok') {
      alert('Save failed: ' + result);
      return;
    }
    close();
  }

  async function handleDelete() {
    const c = cmd();
    if (!c) return;
    const cmdId = c.id;
    const projIdx = projects.findIndex(p => p.id === selectedId());
    if (projIdx === -1) return;
    setProjects(projIdx, 'commands', (cmds: any[]) => cmds.filter((cm: any) => cm.id !== cmdId));
    setProjects(projIdx, 'shortcuts', (shortcuts: any[] | undefined) =>
      (shortcuts || []).map((s: any) => ({ ...s, commandIds: s.commandIds.filter((id: string) => id !== cmdId) }))
    );
    const result = await go.SaveProjects(projects as any);
    if (result !== 'ok') { alert('Save failed: ' + result); return; }
    close();
  }

  async function handleBrowse() {
    const path = await go.PickFolder();
    if (path) setWorkingDir(path);
  }

  function addPreHook() {
    setPreHooks(prev => [...prev, '']);
  }

  function updatePreHook(idx: number, value: string) {
    setPreHooks(prev => prev.map((h, i) => i === idx ? value : h));
  }

  function removePreHook(idx: number) {
    setPreHooks(prev => prev.filter((_, i) => i !== idx));
  }

  function addPostHook() {
    setPostHooks(prev => [...prev, { command: '', timeout: '' }]);
  }

  function updatePostHook(idx: number, field: 'command' | 'timeout', value: string) {
    setPostHooks(prev => prev.map((h, i) => i === idx ? { ...h, [field]: value } : h));
  }

  function removePostHook(idx: number) {
    setPostHooks(prev => prev.filter((_, i) => i !== idx));
  }

  return (
    <Show when={editingCmd()}>
      <div class="modal-overlay" onClick={handleOverlayClick}>
        <div class="modal-box">
          <div class="modal-title">Edit Command</div>
          <input placeholder="Label" value={label()} onInput={e => setLabel(e.currentTarget.value)} />
          <input placeholder="Group" value={group()} onInput={e => setGroup(e.currentTarget.value)} />
          <input
            placeholder="shell command…"
            value={command()}
            onInput={e => setCommand(e.currentTarget.value)}
            style={{ "font-family": "var(--mono)", "font-size": "12px" }}
          />
          <div class="add-cmd-dir-row">
            <input
              placeholder="Working dir (optional, defaults to project path)"
              value={workingDir()}
              onInput={e => setWorkingDir(e.currentTarget.value)}
              style={{ "font-family": "var(--mono)", "font-size": "12px" }}
            />
            <button class="add-cmd-dir-pick" type="button" onClick={handleBrowse}>Browse</button>
          </div>
          <label class="interactive-toggle">
            <input
              type="checkbox"
              checked={interactive()}
              onChange={e => setInteractive(e.currentTarget.checked)}
            />
            Interactive — accepts stdin input while running
          </label>

          <div class="pre-hooks-section">
            <div class="pre-hooks-header">Pre-hook Commands</div>
            {/* Index, not For: For keys by value for a string list, so every
                keystroke changed the key, rebuilt the row, and dropped focus. */}
            <Index each={preHooks()}>
              {(hook, idx) => (
                <div class="pre-hook-row">
                  <input
                    class="pre-hook-input"
                    placeholder="shell command…"
                    value={hook()}
                    onInput={e => updatePreHook(idx, e.currentTarget.value)}
                  />
                  <button class="pre-hook-del-btn" type="button" onClick={() => removePreHook(idx)}>✕</button>
                </div>
              )}
            </Index>
            <button type="button" onClick={addPreHook} style={{ background: "transparent", border: "1px dashed var(--border)", color: "var(--muted)", "border-radius": "var(--radius)", padding: "5px 10px", cursor: "pointer", "font-size": "11px", "text-align": "left" }}>
              + Add pre-hook
            </button>
          </div>

          <div class="pre-hooks-section">
            <div class="pre-hooks-header">
              Post-hook Commands <span class="hook-hint">run after main starts · default 120 s timeout</span>
            </div>
            <Index each={postHooks()}>
              {(hook, idx) => (
                <div class="post-hook-row">
                  <input
                    class="post-hook-input"
                    placeholder="shell command…"
                    value={hook().command}
                    onInput={e => updatePostHook(idx, 'command', e.currentTarget.value)}
                  />
                  <input
                    class="post-hook-timeout"
                    type="number"
                    placeholder="120"
                    value={hook().timeout}
                    min="1"
                    max="3600"
                    title="Timeout in seconds (default: 120)"
                    onInput={e => updatePostHook(idx, 'timeout', e.currentTarget.value)}
                  />
                  <span class="post-hook-timeout-label">s</span>
                  <button class="pre-hook-del-btn" type="button" onClick={() => removePostHook(idx)}>✕</button>
                </div>
              )}
            </Index>
            <button type="button" onClick={addPostHook} style={{ background: "transparent", border: "1px dashed var(--border)", color: "var(--muted)", "border-radius": "var(--radius)", padding: "5px 10px", cursor: "pointer", "font-size": "11px", "text-align": "left" }}>
              + Add post-hook
            </button>
          </div>

          <div class="danger-zone">
            <Show when={!confirmingDelete()}>
              <button class="btn-danger" onClick={() => setConfirmingDelete(true)}>Delete Command</button>
            </Show>
            <Show when={confirmingDelete()}>
              <div class="delete-confirm-row">
                <span class="delete-confirm-label">Delete "{cmd()?.label}"?</span>
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
