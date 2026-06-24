import { onMount, onCleanup } from 'solid-js';
import {
  projects, setProjects,
  selectedId, setSelectedId, setSelectedGroup,
  sidebarWidth, groupsWidth, sidebarCollapsed,
  setEditingCmd, setEditingShortcut, setSettingsProjectId,
  updateCmdState,
} from './store';
import { go } from './wails';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import GroupsPanel from './components/GroupsPanel';
import MainPanel from './components/MainPanel';
import StatusBar from './components/StatusBar';
import ResizeHandle from './components/ResizeHandle';
import EditCommandModal from './components/modals/EditCommandModal';
import ShortcutModal from './components/modals/ShortcutModal';
import ProjectSettingsModal from './components/modals/ProjectSettingsModal';
import {
  setSidebarWidth, setGroupsWidth,
} from './store';

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

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      setEditingCmd(null);
      setEditingShortcut(null);
      setSettingsProjectId(null);
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleKeydown);
  });

  function handleSidebarResize() {
    applyColumnWidths(sidebarCollapsed(), sidebarWidth(), groupsWidth());
  }

  function handleGroupsResize() {
    applyColumnWidths(sidebarCollapsed(), sidebarWidth(), groupsWidth());
  }

  return (
    <>
      <Header />
      <Sidebar onResize={handleSidebarResize} />
      <GroupsPanel onResize={handleGroupsResize} />
      <MainPanel />
      <StatusBar />
      <EditCommandModal />
      <ShortcutModal />
      <ProjectSettingsModal />
    </>
  );
}
