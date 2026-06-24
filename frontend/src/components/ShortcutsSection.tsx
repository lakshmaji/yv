import { For, Show } from 'solid-js';
import { projects, selectedProject, setEditingShortcut } from '../store';
import { go } from '../wails';
import ShortcutCard from './ShortcutCard';

export default function ShortcutsSection() {
  const proj = () => selectedProject();

  async function handleDelete(id: string) {
    const p = proj();
    if (!p || !p.shortcuts) return;
    const idx = p.shortcuts.findIndex(s => s.id === id);
    if (idx === -1) return;
    p.shortcuts.splice(idx, 1);
    await go.SaveProjects(projects as any);
  }

  return (
    <div id="shortcuts-section">
      <div class="shortcuts-header">
        <span class="shortcuts-title">Shortcuts</span>
        <button id="add-shortcut-btn" onClick={() => setEditingShortcut('new')}>
          + New Shortcut
        </button>
      </div>
      <div id="shortcuts-list">
        <Show when={proj()?.shortcuts}>
          <For each={proj()!.shortcuts}>
            {(sc) => (
              <ShortcutCard
                shortcut={sc}
                project={proj()!}
                onDelete={handleDelete}
              />
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
