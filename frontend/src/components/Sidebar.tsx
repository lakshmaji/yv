import { createSignal, For, Show } from 'solid-js';
import type { Project } from '../types';
import {
  projects, setProjects,
  selectedId, setSelectedId,
  setSelectedGroup,
  sidebarCollapsed, setSidebarCollapsed,
  runningCount, projectRunningCount,
  setSettingsProjectId, setSearchQuery, setSpotlightOpen,
} from '../store';
import { go } from '../wails';
import { uid } from '../lib/utils';
import ResizeHandle from './ResizeHandle';
import { sidebarWidth, setSidebarWidth } from '../store';

interface SidebarProps {
  onResize: () => void;
}

export default function Sidebar(props: SidebarProps) {
  const [showForm, setShowForm] = createSignal(false);
  const [npName, setNpName] = createSignal('');
  const [npDir, setNpDir] = createSignal('');
  const [nameError, setNameError] = createSignal(false);
  const [dirError, setDirError] = createSignal(false);

  const hintText = (): string => {
    if (nameError() && dirError()) return 'Enter a project name and choose a folder.';
    if (nameError()) return 'Enter a project name.';
    if (dirError()) return 'Choose a folder for this project.';
    return '';
  };

  function selectProject(id: string): void {
    setSelectedId(id);
    setSelectedGroup('All');
  }

  async function handleBrowse(): Promise<void> {
    const path = await go.PickFolder();
    if (path) { setNpDir(path); setDirError(false); }
  }

  async function handleCreate(): Promise<void> {
    const name = npName().trim();
    const dir = npDir().trim();
    const missingName = !name;
    const missingDir = !dir;
    setNameError(missingName);
    setDirError(missingDir);
    if (missingName || missingDir) return;

    const proj: Project = {
      id: uid(),
      name,
      workingDir: dir,
      commands: [],
      groups: [],
    };
    setProjects([...projects, proj]);

    const result = await go.SaveProjects(projects as Project[]);
    if (result !== 'ok') {
      alert('Save failed: ' + result);
      setProjects(projects.filter((p: Project) => p.id !== proj.id));
      return;
    }

    setShowForm(false);
    setNpName('');
    setNpDir('');
    selectProject(proj.id);
  }

  function handleCancel(): void {
    setShowForm(false);
    setNpName('');
    setNpDir('');
    setNameError(false);
    setDirError(false);
  }

  async function handleExport(): Promise<void> {
    try {
      const path = await go.ExportProjects();
      if (path) alert(`Exported to ${path}`);
    } catch (err) {
      alert('Export failed: ' + err);
    }
  }

  async function handleImport(): Promise<void> {
    try {
      const msg = await go.ImportProjects();
      if (!msg) return;
      setProjects(await go.LoadProjects());
      alert(msg);
    } catch (err) {
      alert('Import failed: ' + err);
    }
  }

  async function handleImportProject(): Promise<void> {
    try {
      const msg = await go.ImportProject();
      if (!msg) return;
      setProjects(await go.LoadProjects());
      alert(msg);
    } catch (err) {
      alert('Import failed: ' + err);
    }
  }

  const headerLabel = (): string => {
    const count = runningCount();
    return count > 0 ? `Projects (${count})` : 'Projects';
  };

  return (
    <nav
      id="sidebar"
      classList={{ collapsed: sidebarCollapsed() }}
    >
      <div id="sidebar-header">
        <span class="sidebar-label">{headerLabel()}</span>
        <button
          class="sidebar-toggle"
          id="sidebar-toggle-btn"
          title={sidebarCollapsed() ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => { setSidebarCollapsed(!sidebarCollapsed()); props.onResize(); }}
        >
          {sidebarCollapsed() ? '›' : '‹'}
        </button>
      </div>

      <button
        id="spotlight-trigger"
        type="button"
        title="Search commands across all projects (⌘K)"
        onClick={() => { setSearchQuery(''); setSpotlightOpen(true); }}
      >
        <span class="spotlight-trigger-icon">⌕</span>
        <span class="spotlight-trigger-label">Search</span>
        <kbd class="spotlight-trigger-kbd">⌘K</kbd>
      </button>

      <div id="project-list">
        <For each={projects}>
          {(p: Project) => {
            const rc = (): number => projectRunningCount(p.id);
            const initials = (): string => p.name.slice(0, 2).toUpperCase();

            const hasColor = (): boolean => !!(p.labelBgColor || p.labelTxColor);
            const dotStyle = () => p.labelBgColor ? { background: p.labelBgColor } : {};
            const avatarStyle = () => {
              const s: Record<string, string> = {};
              if (p.labelBgColor) { s['background'] = p.labelBgColor; s['border-color'] = p.labelBgColor; }
              if (p.labelTxColor) s['color'] = p.labelTxColor;
              return s;
            };
            const nameStyle = () => {
              const s: Record<string, string> = {};
              if (p.labelBgColor) s['background'] = p.labelBgColor;
              if (p.labelTxColor) s['color'] = p.labelTxColor;
              return s;
            };

            return (
              <div
                classList={{
                  'project-item': true,
                  active: selectedId() === p.id,
                  'has-running': rc() > 0,
                }}
                title={p.name}
                onClick={() => selectProject(p.id)}
              >
                <span class="project-avatar" style={avatarStyle()}>{initials()}</span>
                <span class="project-dot" style={dotStyle()} />
                <span
                  class="project-name"
                  classList={{ 'project-name-chip': hasColor() }}
                  style={nameStyle()}
                >
                  {p.name}
                </span>
                <Show when={rc() > 0}>
                  <span class="project-running-count" style={{ display: 'inline-block' }}>
                    {rc()}
                  </span>
                </Show>
                <button
                  class="project-settings-btn"
                  title="Project settings"
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    setSettingsProjectId(p.id);
                  }}
                >
                  ⚙
                </button>
              </div>
            );
          }}
        </For>
      </div>

      <button
        id="add-project-btn"
        onClick={() => {
          const next = !showForm();
          setShowForm(next);
          if (!next) { setNameError(false); setDirError(false); }
        }}
      >
        + New Project
      </button>

      <Show when={showForm()}>
        <div id="new-project-form" class="visible">
          <input
            id="np-name"
            placeholder="Project name"
            classList={{ 'input-error': nameError() }}
            value={npName()}
            onInput={(e: InputEvent) => { setNpName((e.target as HTMLInputElement).value); setNameError(false); }}
          />
          <div class="form-row">
            <input
              id="np-dir"
              placeholder="Folder path"
              style={{ flex: '1' }}
              classList={{ 'input-error': dirError() }}
              value={npDir()}
              onInput={(e: InputEvent) => { setNpDir((e.target as HTMLInputElement).value); setDirError(false); }}
            />
            <button class="pick-btn" id="np-pick" onClick={handleBrowse}>
              Browse
            </button>
          </div>
          <Show when={nameError() || dirError()}>
            <div class="np-form-hint">{hintText()}</div>
          </Show>
          <div class="form-actions">
            <button class="btn-primary" id="np-save" onClick={handleCreate}>
              Create
            </button>
            <button class="btn-cancel" id="np-cancel" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        </div>
      </Show>

      <button
        id="btn-import-project"
        title="Import a single project from JSON or YAML"
        onClick={handleImportProject}
      >
        ↓ Import Project
      </button>

      <div id="data-actions">
        <button
          id="btn-export"
          title="Export all projects to JSON or YAML"
          onClick={handleExport}
        >
          ↑ Export
        </button>
        <button
          id="btn-import"
          title="Import projects from JSON or YAML"
          onClick={handleImport}
        >
          ↓ Import
        </button>
      </div>
      <ResizeHandle
        id="rh-sidebar"
        getWidth={sidebarWidth}
        setWidth={setSidebarWidth}
        onResize={props.onResize}
      />
    </nav>
  );
}
