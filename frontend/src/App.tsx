import { onMount, onCleanup, createEffect, Show } from 'solid-js';
import {
  projects, setProjects,
  selectedId, setSelectedId, setSelectedGroup,
  sidebarWidth, groupsWidth, sidebarCollapsed, setSidebarCollapsed, groupsCollapsed,
  setEditingCmd, setEditingShortcut, setSettingsProjectId,
  updateCmdState, setSearchQuery, setEnvModalOpen, loadProjectEnvs,
  spotlightOpen, setSpotlightOpen,
  editingCmd, editingShortcut, settingsProjectId, envModalOpen,
  maximizedCmd, setMaximizedCmd, filteredCommands,
  setShortcutsModalOpen,
  activeView, setActiveView,
  settingsModalOpen, setSettingsModalOpen, loadAppSettings,
} from './store';
import { go, runtime } from './wails';
import { stopAllCommands } from './lib/commands';
import Sidebar from './components/Sidebar';
import GroupsPanel from './components/GroupsPanel';
import MainPanel from './components/MainPanel';
import StatusBar from './components/StatusBar';
import ResizeHandle from './components/ResizeHandle';
import Spotlight from './components/Spotlight';
import EnvironmentsModal from './components/modals/EnvironmentsModal';
import EditCommandModal from './components/modals/EditCommandModal';
import ShortcutModal from './components/modals/ShortcutModal';
import ProjectSettingsModal from './components/modals/ProjectSettingsModal';
import KeyboardShortcutsModal from './components/modals/KeyboardShortcutsModal';
import SettingsModal from './components/modals/SettingsModal';
import DashboardPanel from './components/DashboardPanel';
import {
  setSidebarWidth, setGroupsWidth, setResourceStats,
} from './store';
import type { ResourceStats, ProcessStats } from './types';

/**
 * Pushes the current column widths onto the body grid.
 *
 * Reads the signals directly rather than taking them as arguments, so a single
 * createEffect keeps the layout in sync and no caller has to remember to pass
 * the view. In dashboard view the groups column collapses to zero — the
 * dashboard is app-wide, so per-project groups are meaningless there.
 */
function applyColumnWidths() {
  const effectiveSw = sidebarCollapsed() ? 48 : sidebarWidth();
  if (activeView() === 'dashboard') {
    document.body.style.gridTemplateColumns = `${effectiveSw}px 0px 1fr`;
    return;
  }
  const effectiveGw = groupsCollapsed() ? 48 : groupsWidth();
  document.body.style.gridTemplateColumns = `${effectiveSw}px ${effectiveGw}px 1fr`;
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

  // Switching project or group unmounts the maximized row — drop the focus
  // rather than leaving an invisible one latched.
  createEffect(() => {
    const id = maximizedCmd();
    if (id && !filteredCommands().some(c => c.id === id)) setMaximizedCmd(null);
  });

  // Keep the environment panel in sync with the selected project.
  createEffect(() => {
    loadProjectEnvs(selectedId(), go.GetEnvironments);
  });

  // The dashboard and its empty state both need to know the metrics toggle
  // before the view is first opened.
  onMount(() => {
    void loadAppSettings(go.GetSettings);
  });

  function handleKeydown(e: KeyboardEvent) {
    // ⌘K / ⌘F open the global Spotlight search from anywhere in the app.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'f')) {
      e.preventDefault();
      setSearchQuery('');
      setSpotlightOpen(true);
      return;
    }
    // ⌘B toggles the main project sidebar, VSCode-style.
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
      e.preventDefault();
      setSidebarCollapsed(!sidebarCollapsed());
      return;
    }
    // ⌘. (the macOS cancel gesture) stops every running command at once.
    if ((e.metaKey || e.ctrlKey) && e.key === '.') {
      e.preventDefault();
      stopAllCommands();
      return;
    }
    if (e.key === 'Escape') {
      // A maximized terminal is below any modal, so it only yields to Esc
      // once nothing is stacked on top of it.
      const modalOpen =
        editingCmd() || editingShortcut() || settingsProjectId() || envModalOpen() || settingsModalOpen();
      if (maximizedCmd() && !modalOpen) {
        setMaximizedCmd(null);
        return;
      }
      setEditingCmd(null);
      setEditingShortcut(null);
      setSettingsProjectId(null);
      setEnvModalOpen(false);
      setShortcutsModalOpen(false);
      setSettingsModalOpen(false);
    }
  }

  let unsubFullscreen: (() => void) | undefined;
  let unsubResources: (() => void) | undefined;
  let unsubShortcuts: (() => void) | undefined;
  let unsubSettings: (() => void) | undefined;
  let unsubDashboard: (() => void) | undefined;

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
    unsubShortcuts = runtime.EventsOn('open-keyboard-shortcuts', () => {
      setShortcutsModalOpen(true);
    });
    // ⌘, and ⌘D are native menu accelerators — macOS swallows them before they
    // reach the webview, so they arrive only as these events.
    unsubSettings = runtime.EventsOn('open-settings', () => {
      setSettingsModalOpen(true);
    });
    unsubDashboard = runtime.EventsOn('open-dashboard', () => {
      setActiveView('dashboard');
    });
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleKeydown);
    unsubFullscreen?.();
    unsubResources?.();
    unsubShortcuts?.();
    unsubSettings?.();
    unsubDashboard?.();
  });

  // Column widths are driven by one effect, so a resize, a collapse, or a view
  // switch all converge on the same code path.
  createEffect(applyColumnWidths);

  return (
    <>
      <Sidebar onResize={applyColumnWidths} />
      <Show when={activeView() === 'commands'}>
        <GroupsPanel onResize={applyColumnWidths} />
      </Show>
      <Show when={activeView() === 'dashboard'} fallback={<MainPanel />}>
        <DashboardPanel />
      </Show>
      <StatusBar />
      <EditCommandModal />
      <ShortcutModal />
      <ProjectSettingsModal />
      <EnvironmentsModal />
      <KeyboardShortcutsModal />
      <SettingsModal />
      <Show when={spotlightOpen()}>
        <Spotlight />
      </Show>
    </>
  );
}
