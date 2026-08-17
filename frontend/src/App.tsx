import { onMount, onCleanup, createEffect, Match, Show, Switch } from 'solid-js';
import {
  projects, setProjects,
  selectedId, setSelectedId, setSelectedGroup,
  sidebarWidth, groupsWidth, sidebarCollapsed, setSidebarCollapsed, groupsCollapsed,
  setEditingCmd, setEditingShortcut, setSettingsProjectId,
  updateCmdState, setSearchQuery, setEnvModalOpen, loadProjectEnvs,
  spotlightOpen, setSpotlightOpen,
  editingCmd, editingShortcut, settingsProjectId, envModalOpen,
  maximizedCmd, setMaximizedCmd, filteredCommands,
  shortcutsModalOpen, setShortcutsModalOpen,
  aboutModalOpen, setAboutModalOpen,
  updateModalOpen, setUpdateModalOpen, setUpdateState,
  activeView, setActiveView,
  settingsModalOpen, setSettingsModalOpen, loadAppSettings,
  scanModalOpen, setScanModalOpen, setScanHits,
  splashDone,
} from './store';
import { go, runtime } from './wails';
import { stopAllCommands } from './lib/commands';
import Sidebar from './components/Sidebar';
import GroupsPanel from './components/GroupsPanel';
import MainPanel from './components/MainPanel';
import StatusBar from './components/StatusBar';
import ResizeHandle from './components/ResizeHandle';
import Spotlight from './components/Spotlight';
import Splash from './components/Splash';
import EnvironmentsModal from './components/modals/EnvironmentsModal';
import EditCommandModal from './components/modals/EditCommandModal';
import ShortcutModal from './components/modals/ShortcutModal';
import ProjectSettingsModal from './components/modals/ProjectSettingsModal';
import KeyboardShortcutsModal from './components/modals/KeyboardShortcutsModal';
import AboutModal from './components/modals/AboutModal';
import UpdateModal from './components/modals/UpdateModal';
import SettingsModal from './components/modals/SettingsModal';
import ScanModal from './components/modals/ScanModal';
import IncomingShareModal from './components/modals/IncomingShareModal';
import IncomingConnectModal from './components/modals/IncomingConnectModal';
import DashboardPanel from './components/DashboardPanel';
import DiscoveryPanel from './components/DiscoveryPanel';
import {
  setSidebarWidth, setGroupsWidth, setResourceStats,
} from './store';
import type {
  ResourceStats,
  ProcessStats,
  PeerInfo,
  ScanHit,
  IncomingShare,
  IncomingConnect,
  ShareProgress,
  UpdateState,
} from './types';
import {
  setPeers,
  setSharePeer,
  setIncomingConnect,
  shareBusy,
  setSendProgress,
  setRecvProgress,
  incomingConnect,
  setShareBusy,
  setShareError,
  incomingShare,
  setIncomingShare,
  setIncomingResult,
  incomingBusy,
  setIncomingBusy,
  setIncomingError,
} from './store';

/**
 * Pushes the current column widths onto the body grid.
 *
 * Reads the signals directly rather than taking them as arguments, so a single
 * createEffect keeps the layout in sync and no caller has to remember to pass
 * the view. Outside the command view the groups column collapses to zero — the
 * dashboard and Discovery are app-wide, so per-project groups are meaningless
 * there.
 */
function applyColumnWidths() {
  const effectiveSw = sidebarCollapsed() ? 48 : sidebarWidth();
  if (activeView() !== 'commands') {
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

  // Whether anything is stacked over the app. Two callers ask: Escape, deciding
  // whether it should un-maximize a terminal or close a modal, and the
  // background scan, deciding whether it may open its dialog unprompted.
  const anyModalOpen = () =>
    !!(editingCmd() || editingShortcut() || settingsProjectId() || envModalOpen() ||
      settingsModalOpen() || shortcutsModalOpen() || aboutModalOpen() ||
      updateModalOpen() || scanModalOpen());

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
      if (maximizedCmd() && !anyModalOpen()) {
        setMaximizedCmd(null);
        return;
      }
      setEditingCmd(null);
      setEditingShortcut(null);
      setSettingsProjectId(null);
      setEnvModalOpen(false);
      setShortcutsModalOpen(false);
      setSettingsModalOpen(false);
      setAboutModalOpen(false);
      setUpdateModalOpen(false);
      // Deliberately leaves scanHits alone: dismissing without deciding is not
      // an answer, so the prompt returns on the next scan.
      setScanModalOpen(false);
    }
  }

  let unsubFullscreen: (() => void) | undefined;
  let unsubResources: (() => void) | undefined;
  let unsubShortcuts: (() => void) | undefined;
  let unsubAbout: (() => void) | undefined;
  let unsubUpdateMenu: (() => void) | undefined;
  let unsubUpdateState: (() => void) | undefined;
  let unsubSettings: (() => void) | undefined;
  let unsubDashboard: (() => void) | undefined;
  let unsubScan: (() => void) | undefined;
  let unsubScanNew: (() => void) | undefined;
  let unsubPeers: Array<() => void> = [];

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
    unsubAbout = runtime.EventsOn('open-about', () => {
      setAboutModalOpen(true);
    });
    unsubUpdateMenu = runtime.EventsOn('open-update', () => {
      setUpdateModalOpen(true);
      go.CheckForUpdates();
    });
    // Registered here, not in UpdateModal, for the same reason the share
    // listeners are: the check that matters most runs a few seconds after
    // launch with no dialog mounted. Scoped to the component, it would be
    // missed entirely and the user would only learn about an update by going
    // to look for one.
    unsubUpdateState = runtime.EventsOn('update:state', (s: UpdateState) => {
      setUpdateState(s);
      // Opened only for something actionable. A background check that finds
      // nothing, fails, or reports a dev build stays silent — an app that
      // interrupts you to say it has nothing to say gets its updates turned
      // off.
      if (s.status === 'available' || s.status === 'manual') {
        setUpdateModalOpen(true);
      }
    });
    // ⌘, and ⌘D are native menu accelerators — macOS swallows them before they
    // reach the webview, so they arrive only as these events.
    unsubSettings = runtime.EventsOn('open-settings', () => {
      setSettingsModalOpen(true);
    });
    unsubDashboard = runtime.EventsOn('open-dashboard', () => {
      setActiveView('dashboard');
    });
    unsubScan = runtime.EventsOn('open-scan', () => {
      setScanModalOpen(true);
    });

    // The background scan found configs the user has not been asked about.
    // This is the one dialog that can appear unprompted, so it holds back when
    // anything else is up — including the splash — and leaves the Sidebar badge
    // to carry it instead. Nothing is imported either way.
    unsubScanNew = runtime.EventsOn('scan:new', (hits: ScanHit[]) => {
      if (!hits?.length) return;
      setScanHits(hits);
      if (!anyModalOpen() && splashDone()) setScanModalOpen(true);
    });

    // Peer and share events are wired here rather than in DiscoveryPanel on
    // purpose: the share node keeps running once started, so an offer can arrive
    // while the user is looking at their commands. A listener scoped to the
    // Discovery view would drop that prompt on the floor and leave the sender
    // waiting on a dialog nobody ever saw.
    unsubPeers = [
      runtime.EventsOn('peer:found', (p: PeerInfo) => {
        // mDNS re-announces periodically, so dedup or a peer grows a new
        // dinosaur every announcement.
        setPeers(prev => (prev.some(x => x.id === p.id) ? prev : [...prev, p]));
      }),
      runtime.EventsOn('peer:lost', (e: { id: string }) => {
        setPeers(prev => prev.filter(x => x.id !== e.id));
        // A peer that vanished mid-connect cannot be let in.
        setIncomingConnect(cur => (cur?.peerId === e.id ? null : cur));
        // ...but a transfer in flight is not interrupted just because discovery
        // stopped hearing about the device. Go now holds a peer alive while it
        // is streaming, so this is a backstop: the transfer owns its own errors,
        // and yanking the dialog would hide whichever one it reports.
        if (shareBusy()) return;
        setSharePeer(cur => (cur?.id === e.id ? null : cur));
      }),
      runtime.EventsOn('share:connect-request', (req: IncomingConnect) => {
        setIncomingConnect(req);
      }),
      // Emitted however the request ended — accepted, refused, or timed out —
      // so a prompt is never left on screen for a stream that has gone.
      runtime.EventsOn('share:connect-closed', (e: { requestId: string }) => {
        setIncomingConnect(cur => (cur?.requestId === e.requestId ? null : cur));
      }),
      runtime.EventsOn('share:incoming', (offer: IncomingShare) => {
        setIncomingResult(null);
        setIncomingShare(offer);
      }),
      // Throttled on the Go side, so this fires a few times a second rather
      // than once per chunk.
      runtime.EventsOn('share:progress', (p: ShareProgress) => {
        if (p.direction === 'send') setSendProgress(p);
        else setRecvProgress(p);
      }),
      runtime.EventsOn('share:imported', (e: { summary: string }) => {
        setRecvProgress(null);
        setIncomingResult(e.summary);
        // The projects file was written underneath us; reload so the sidebar
        // shows what arrived without needing a restart.
        void go.LoadProjects()
          .then(loaded => setProjects(loaded as any))
          .catch(() => { /* it is on disk either way */ });
      }),
      // Both ends emit this. A receiver mid-transfer owns the failure — its
      // dialog is the one on screen, and without this it would sit on
      // "Receiving…" forever now that nothing closes it on a timer.
      runtime.EventsOn('share:error', (e: { message: string }) => {
        if (incomingBusy()) {
          setIncomingBusy(false);
          setIncomingError(e.message);
          setRecvProgress(null);
          return;
        }
        setShareBusy(false);
        setShareError(e.message);
      }),
    ];
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleKeydown);
    unsubFullscreen?.();
    unsubResources?.();
    unsubShortcuts?.();
    unsubAbout?.();
    unsubUpdateMenu?.();
    unsubUpdateState?.();
    unsubSettings?.();
    unsubDashboard?.();
    unsubScan?.();
    unsubScanNew?.();
    unsubPeers.forEach(off => off());
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
      <Switch fallback={<MainPanel />}>
        <Match when={activeView() === 'dashboard'}>
          <DashboardPanel />
        </Match>
        <Match when={activeView() === 'discovery'}>
          <DiscoveryPanel />
        </Match>
      </Switch>
      <StatusBar />
      <EditCommandModal />
      <ShortcutModal />
      <ProjectSettingsModal />
      <EnvironmentsModal />
      <KeyboardShortcutsModal />
      <AboutModal />
      <UpdateModal />
      <SettingsModal />
      <ScanModal />
      {/* Global, not inside DiscoveryPanel: a request can arrive on any view. */}
      <Show when={incomingConnect()}>
        <IncomingConnectModal />
      </Show>
      <Show when={incomingShare()}>
        <IncomingShareModal />
      </Show>
      <Show when={spotlightOpen()}>
        <Spotlight />
      </Show>
      {/* Last, so it covers everything. It is fixed-position, so it takes no
          column in the body grid — boot carries on underneath it. */}
      <Show when={!splashDone()}>
        <Splash />
      </Show>
    </>
  );
}
