import { Show, For, createSignal, createEffect, onMount } from 'solid-js';
import { projects, selectedProject, editingShortcut, setEditingShortcut } from '../../store';
import { go } from '../../wails';
import { uid, escHtml } from '../../lib/utils';
import type { Shortcut, CommandConfig } from '../../types';

export default function ShortcutModal() {
  const [name, setName] = createSignal('');
  const [orderedCmds, setOrderedCmds] = createSignal<{ cmd: CommandConfig; checked: boolean }[]>([]);
  const [nameError, setNameError] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  const isNew = () => editingShortcut() === 'new';

  const shortcut = (): Shortcut | null => {
    const proj = selectedProject();
    const id = editingShortcut();
    if (!proj || !id || id === 'new') return null;
    return proj.shortcuts?.find(s => s.id === id) || null;
  };

  createEffect(() => {
    const id = editingShortcut();
    if (!id) return;
    const proj = selectedProject();
    if (!proj) return;

    const sc = shortcut();
    setName(sc ? sc.name : '');
    setNameError(false);

    if (sc) {
      const checked = sc.commandIds
        .map(cid => proj.commands.find(c => c.id === cid))
        .filter(Boolean)
        .map(c => ({ cmd: c!, checked: true }));
      const unchecked = proj.commands
        .filter(c => !sc.commandIds.includes(c.id))
        .map(c => ({ cmd: c, checked: false }));
      setOrderedCmds([...checked, ...unchecked]);
    } else {
      setOrderedCmds(proj.commands.map(c => ({ cmd: c, checked: false })));
    }
  });

  function close() {
    setEditingShortcut(null);
  }

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function toggleCmd(cmdId: string) {
    setOrderedCmds(prev =>
      prev.map(item =>
        item.cmd.id === cmdId ? { ...item, checked: !item.checked } : item
      )
    );
  }

  async function handleSave() {
    const proj = selectedProject();
    if (!proj) return;
    const n = name().trim();
    if (!n) {
      setNameError(true);
      return;
    }
    const commandIds = orderedCmds()
      .filter(item => item.checked)
      .map(item => item.cmd.id);
    if (commandIds.length === 0) {
      alert('Select at least one command.');
      return;
    }

    if (!proj.shortcuts) proj.shortcuts = [];
    const sc = shortcut();
    if (sc) {
      sc.name = n;
      sc.commandIds = commandIds;
    } else {
      proj.shortcuts.push({ id: uid(), name: n, commandIds });
    }

    const result = await go.SaveProjects(projects as any);
    if (result !== 'ok') {
      alert('Save failed: ' + result);
      return;
    }
    close();
  }

  // Drag reorder
  let dragging: HTMLDivElement | null = null;

  function handleDragStart(e: DragEvent) {
    const handle = (e.target as HTMLElement).closest('.sc-drag-handle');
    if (!handle) { e.preventDefault(); return; }
    dragging = (handle as HTMLElement).closest('.sc-cmd-checkbox-row') as HTMLDivElement;
    if (!dragging) return;
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setDragImage(dragging, 20, dragging.offsetHeight / 2);
    setTimeout(() => dragging?.classList.add('sc-dragging'), 0);
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (!dragging || !containerRef) return;
    const target = (e.target as HTMLElement).closest('.sc-cmd-checkbox-row') as HTMLDivElement | null;
    if (!target || target === dragging) return;
    const rect = target.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      containerRef.insertBefore(dragging, target);
    } else {
      containerRef.insertBefore(dragging, target.nextSibling);
    }
  }

  function handleDragEnd() {
    if (dragging) {
      dragging.classList.remove('sc-dragging');
      // Sync DOM order back to state
      if (containerRef) {
        const rows = containerRef.querySelectorAll('.sc-cmd-checkbox-row');
        const newOrder: { cmd: CommandConfig; checked: boolean }[] = [];
        const current = orderedCmds();
        rows.forEach(row => {
          const cmdId = (row as HTMLElement).dataset.cmdid;
          const item = current.find(i => i.cmd.id === cmdId);
          if (item) newOrder.push(item);
        });
        if (newOrder.length === current.length) {
          setOrderedCmds(newOrder);
        }
      }
      dragging = null;
    }
  }

  return (
    <Show when={editingShortcut()}>
      <div class="modal-overlay" onClick={handleOverlayClick}>
        <div class="modal-box">
          <div class="modal-title">{isNew() ? 'New Shortcut' : 'Edit Shortcut'}</div>
          <input
            placeholder="Shortcut name (e.g. Build & Deploy)"
            value={name()}
            onInput={e => { setName(e.currentTarget.value); setNameError(false); }}
            classList={{ 'input-error': nameError() }}
          />
          <div class="sc-cmd-list-header">Commands to run in order</div>
          <div
            class="sc-cmd-checkboxes"
            ref={containerRef}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            <For each={orderedCmds()}>
              {(item) => (
                <div class="sc-cmd-checkbox-row" data-cmdid={item.cmd.id}>
                  <span class="sc-drag-handle" draggable={true} title="Drag to reorder">⠿</span>
                  <label class="sc-cmd-cb-label-wrap">
                    <input
                      type="checkbox"
                      class="sc-cmd-cb"
                      checked={item.checked}
                      onChange={() => toggleCmd(item.cmd.id)}
                    />
                    <span class="sc-cmd-cb-label">{item.cmd.label}</span>
                  </label>
                  <span class="sc-cmd-cb-snippet">{item.cmd.command}</span>
                </div>
              )}
            </For>
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
