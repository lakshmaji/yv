import { createSignal, For, Show } from 'solid-js';
import type { Project } from '../types';
import {
  projects, setProjects,
  selectedGroup, setSelectedGroup,
  visibleGroups,
  selectedProject,
  selectedId,
} from '../store';
import { go } from '../wails';
import ResizeHandle from './ResizeHandle';
import { groupsWidth, setGroupsWidth, groupsCollapsed, setGroupsCollapsed } from '../store';

interface GroupsPanelProps {
  onResize: () => void;
}

export default function GroupsPanel(props: GroupsPanelProps) {
  const [showForm, setShowForm] = createSignal(false);
  const [groupName, setGroupName] = createSignal('');
  const [nameError, setNameError] = createSignal('');

  const allGroups = (): string[] => ['All', ...visibleGroups()];

  async function addGroup(name: string): Promise<boolean> {
    const proj = selectedProject();
    if (!proj) return false;
    if ((proj.groups || []).includes(name)) return false;
    const projIdx = projects.findIndex(p => p.id === proj.id);
    setProjects(projIdx, 'groups', (groups: string[]) => [...(groups || []), name]);
    const result = await go.SaveProjects(projects as Project[]);
    if (result !== 'ok') {
      alert('Save failed: ' + result);
      setProjects(projIdx, 'groups', (groups: string[]) => groups.filter(g => g !== name));
      return false;
    }
    return true;
  }

  async function handleDeleteGroup(groupName: string): Promise<void> {
    const proj = selectedProject();
    if (!proj) return;
    const projIdx = projects.findIndex(pr => pr.id === selectedId());
    if (projIdx === -1) return;
    setProjects(projIdx, 'groups', (groups: string[]) => (groups || []).filter(g => g !== groupName));
    setProjects(projIdx, 'commands', (cmds: any[]) =>
      cmds.map((c: any) => c.group === groupName ? { ...c, group: '' } : c)
    );
    if (projects[projIdx].groupPaths) {
      const newPaths = { ...projects[projIdx].groupPaths };
      delete newPaths[groupName];
      setProjects(projIdx, 'groupPaths', newPaths);
    }
    const result = await go.SaveProjects(projects as Project[]);
    if (result !== 'ok') { alert('Save failed: ' + result); return; }
    if (selectedGroup() === groupName) setSelectedGroup('All');
  }

  async function handleAddGroup(): Promise<void> {
    const name = groupName().trim();
    if (!name) {
      setNameError('Enter a group name.');
      return;
    }
    const proj = selectedProject();
    if (proj && (proj.groups || []).includes(name)) {
      setNameError(`A group named "${name}" already exists.`);
      return;
    }
    const ok = await addGroup(name);
    if (!ok) return;
    setShowForm(false);
    setGroupName('');
    setNameError('');
  }

  function handleCancel(): void {
    setShowForm(false);
    setGroupName('');
    setNameError('');
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      handleAddGroup();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  }

  return (
    <nav id="groups-panel" classList={{ collapsed: groupsCollapsed() }}>
      <div id="groups-header">
        <span class="groups-label">Groups</span>
        <button
          class="sidebar-toggle"
          title={groupsCollapsed() ? 'Expand groups' : 'Collapse groups'}
          onClick={() => { setGroupsCollapsed(!groupsCollapsed()); props.onResize(); }}
        >
          {groupsCollapsed() ? '›' : '‹'}
        </button>
      </div>
      <div id="groups-list">
        <For each={allGroups()}>
          {(g: string) => (
            <div
              classList={{
                'group-item': true,
                active: g === selectedGroup(),
              }}
              title={g}
              onClick={() => setSelectedGroup(g)}
            >
              <span class="group-avatar">{g.slice(0, 2).toUpperCase()}</span>
              <span class="group-dot" />
              <span class="group-name">{g}</span>
              <Show when={g !== 'All'}>
                <button
                  class="group-delete-btn"
                  title={`Delete group "${g}"`}
                  onClick={e => { e.stopPropagation(); handleDeleteGroup(g); }}
                >✕</button>
              </Show>
            </div>
          )}
        </For>
      </div>

      <button
        id="add-group-btn"
        onClick={() => {
          const next = !showForm();
          setShowForm(next);
          if (!next) setNameError('');
        }}
      >
        + Add Group
      </button>

      <Show when={showForm()}>
        <div id="add-group-form" class="visible">
          <input
            id="ag-name"
            placeholder="Group name"
            classList={{ 'input-error': !!nameError() }}
            value={groupName()}
            onInput={(e: InputEvent) => { setGroupName((e.target as HTMLInputElement).value); setNameError(''); }}
            onKeyDown={handleKeyDown}
          />
          <Show when={nameError()}>
            <div class="np-form-hint">{nameError()}</div>
          </Show>
          <div class="form-actions">
            <button class="btn-primary" id="ag-save" onClick={handleAddGroup}>
              Add
            </button>
            <button class="btn-cancel" id="ag-cancel" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        </div>
      </Show>
      <ResizeHandle
        id="rh-groups"
        getWidth={groupsWidth}
        setWidth={setGroupsWidth}
        onResize={props.onResize}
      />
    </nav>
  );
}
