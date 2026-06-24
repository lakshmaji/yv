import { createSignal, For, Show } from 'solid-js';
import type { Project } from '../types';
import {
  projects,
  selectedGroup, setSelectedGroup,
  visibleGroups,
  selectedProject,
} from '../store';
import { go } from '../wails';
import ResizeHandle from './ResizeHandle';
import { groupsWidth, setGroupsWidth } from '../store';

interface GroupsPanelProps {
  onResize: () => void;
}

export default function GroupsPanel(props: GroupsPanelProps) {
  const [showForm, setShowForm] = createSignal(false);
  const [groupName, setGroupName] = createSignal('');

  const allGroups = (): string[] => ['All', ...visibleGroups()];

  async function addGroup(name: string): Promise<void> {
    const proj = selectedProject();
    if (!proj) return;

    if (!proj.groups) proj.groups = [];
    if (proj.groups.includes(name)) return;

    proj.groups.push(name);

    const result = await go.SaveProjects(projects as Project[]);
    if (result !== 'ok') {
      alert('Save failed: ' + result);
      proj.groups.pop();
    }
  }

  async function handleAddGroup(): Promise<void> {
    const name = groupName().trim();
    if (!name) return;
    await addGroup(name);
    setShowForm(false);
    setGroupName('');
  }

  function handleCancel(): void {
    setShowForm(false);
    setGroupName('');
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      handleAddGroup();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  }

  return (
    <nav id="groups-panel">
      <div id="groups-header">Groups</div>
      <div id="groups-list">
        <For each={allGroups()}>
          {(g: string) => (
            <div
              classList={{
                'group-item': true,
                active: g === selectedGroup(),
              }}
              onClick={() => setSelectedGroup(g)}
            >
              {g}
            </div>
          )}
        </For>
      </div>

      <button
        id="add-group-btn"
        onClick={() => {
          setShowForm(!showForm());
        }}
      >
        + Add Group
      </button>

      <Show when={showForm()}>
        <div id="add-group-form" class="visible">
          <input
            id="ag-name"
            placeholder="Group name"
            value={groupName()}
            onInput={(e: InputEvent) => setGroupName((e.target as HTMLInputElement).value)}
            onKeyDown={handleKeyDown}
          />
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
