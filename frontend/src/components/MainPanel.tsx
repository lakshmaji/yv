import { Show, For, createSignal } from 'solid-js';
import {
  projects, selectedProject, selectedGroup,
  filteredCommands, setSelectedGroup,
} from '../store';
import { go } from '../wails';
import { uid } from '../lib/utils';
import CommandRow from './CommandRow';
import ShortcutsSection from './ShortcutsSection';

export default function MainPanel() {
  const proj = () => selectedProject();
  const isAllGroups = () => selectedGroup() === 'All';

  const displayPath = () => {
    const p = proj();
    if (!p) return '';
    if (!isAllGroups() && p.groupPaths?.[selectedGroup()]) {
      return p.groupPaths[selectedGroup()];
    }
    return p.workingDir;
  };

  async function handleChangePath() {
    const p = proj();
    if (!p) return;
    const path = await go.PickFolder();
    if (!path) return;
    if (!p.groupPaths) (p as any).groupPaths = {};
    p.groupPaths![selectedGroup()] = path;
    await go.SaveProjects(projects as any);
  }

  let labelRef: HTMLInputElement | undefined;
  let groupRef: HTMLInputElement | undefined;
  let commandRef: HTMLInputElement | undefined;

  async function handleAddCommand(e: Event) {
    e.preventDefault();
    const p = proj();
    if (!p) return;
    const label = labelRef!.value.trim();
    const group = groupRef!.value.trim();
    const command = commandRef!.value.trim();
    if (!label || !command) return;

    const newCmd = { id: uid(), label, command, group, workingDir: '' };
    p.commands.push(newCmd);
    const result = await go.SaveProjects(projects as any);
    if (result !== 'ok') {
      alert('Save failed: ' + result);
      p.commands.pop();
      return;
    }
    labelRef!.value = '';
    commandRef!.value = '';
  }

  return (
    <main id="main">
      <Show when={proj()} fallback={<div id="no-project">Select or create a project</div>}>
        <div id="project-header">
          <span id="project-title">{proj()!.name}</span>
          <span id="project-path">{displayPath()}</span>
          <Show when={!isAllGroups()}>
            <button id="change-path-btn" type="button" onClick={handleChangePath}>
              Change Path
            </button>
          </Show>
        </div>

        <ShortcutsSection />

        <div id="commands-list">
          <For each={filteredCommands()}>
            {(cmd) => <CommandRow cmd={cmd} />}
          </For>
        </div>

        <form id="add-cmd-form" autocomplete="off" onSubmit={handleAddCommand}>
          <input ref={labelRef} id="add-cmd-label" placeholder="Label" required />
          <input
            ref={groupRef}
            id="add-cmd-group"
            placeholder="Group"
            value={isAllGroups() ? '' : selectedGroup()}
          />
          <input ref={commandRef} id="add-cmd-command" placeholder="shell command…" required />
          <button id="add-cmd-submit" type="submit">+ Add Command</button>
        </form>
      </Show>
    </main>
  );
}
