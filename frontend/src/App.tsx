import { onMount, onCleanup, createEffect } from 'solid-js';
import {
  projects, setProjects,
  selectedId, setSelectedId, setSelectedGroup,
  sidebarWidth, groupsWidth, sidebarCollapsed,
  setEditingCmd, setEditingShortcut, setSettingsProjectId,
  updateCmdState, setEnvModalOpen, loadProjectEnvs,
} from './store';
import { go, runtime } from './wails';
import Sidebar from './components/Sidebar';
import GroupsPanel from './components/GroupsPanel';
import MainPanel from './components/MainPanel';
import StatusBar from './components/StatusBar';
import ResizeHandle from './components/ResizeHandle';
import EnvironmentsModal from './components/modals/EnvironmentsModal';
import EditCommandModal from './components/modals/EditCommandModal';
import ShortcutModal from './components/modals/ShortcutModal';
import ProjectSettingsModal from './components/modals/ProjectSettingsModal';
import {
  setSidebarWidth, setGroupsWidth, setResourceStats,
} from './store';
import type { ResourceStats, ProcessStats } from './types';

function applyColumnWidths(collapsed: boolean, sw: number, gw: number) {
  const effectiveSw = collapsed ? 48 : sw;
  document.body.style.gridTemplateColumns = `${effectiveSw}px ${gw}px 1fr`;
}

export default function App() {
  onMount(async () => {
    try {
      const loaded = await go.LoadProjects();
      setProjects(loaded as any);
    } catch {
      setProjects([]);
    }

    if (projects.length > 0) {
      setSelectedId(projects[0].id);
    }

    applyColumnWidths(sidebarCollapsed(), sidebarWidth(), groupsWidth());

    // Re-sync running state from Go backend
    try {
      const runningIds = await go.GetRunningCommands();
      const runningSet = new Set(runningIds || []);
      for (const proj of projects) {
        for (const cmd of proj.commands) {
          if (runningSet.has(cmd.id)) {
            updateCmdState(cmd.id, { running: true });
          }
        }
      }
    } catch { /* ignore */ }
  });

  // Keep the environment panel in sync with the selected project.
  createEffect(() => {
    loadProjectEnvs(selectedId(), go.GetEnvironments);
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      setEditingCmd(null);
      setEditingShortcut(null);
      setSettingsProjectId(null);
      setEnvModalOpen(false);
    }
  }

  let unsubFullscreen: (() => void) | undefined;
  let unsubResources: (() => void) | undefined;

  onMount(() => {
    document.addEventListener('keydown', handleKeydown);
    unsubFullscreen = runtime.EventsOn('fullscreen-changed', (isFs: boolean) => {
      document.body.classList.toggle('fullscreen', isFs);
    });
    unsubResources = runtime.EventsOn('resource-stats', (stats: ResourceStats) => {
      const map = new Map<string, ProcessStats>();
      for (const p of (stats.commands || [])) {
        map.set(p.cmdId, p);
      }
      setResourceStats(map);
    });
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleKeydown);
    unsubFullscreen?.();
    unsubResources?.();
  });

  function handleSidebarResize() {
    applyColumnWidths(sidebarCollapsed(), sidebarWidth(), groupsWidth());
  }

  function handleGroupsResize() {
    applyColumnWidths(sidebarCollapsed(), sidebarWidth(), groupsWidth());
  }

  return (
    <>
      <Sidebar onResize={handleSidebarResize} />
      <GroupsPanel onResize={handleGroupsResize} />
      <MainPanel />
      <StatusBar />
      <EditCommandModal />
      <ShortcutModal />
      <ProjectSettingsModal />
      <EnvironmentsModal />
    </>
  );
}
