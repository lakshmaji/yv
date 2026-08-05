import { createSignal, createMemo } from 'solid-js';
import { createStore } from 'solid-js/store';
import type {
  Project,
  CmdState,
  ShortcutState,
  ProcessStats,
  ProjectEnvs,
  EnvVar,
  AppSettings,
  MetricGroupBy,
  MetricsQuery,
  MetricsResult,
  FrequencyResult,
  ActivityHeatmap,
} from './types';

const DEFAULT_CMD_STATE: CmdState = {
  lines: [], collapsed: true, exitCode: null, stopped: false, running: false, trimmedCount: 0,
};

const DEFAULT_SC_STATE: ShortcutState = {
  running: false, finalState: null, steps: {},
};

// Projects — deep reactive store
const [projects, setProjects] = createStore<Project[]>([]);

// Selection
const [selectedId, setSelectedId] = createSignal<string | null>(null);
const [selectedGroup, setSelectedGroup] = createSignal('All');

// Global Spotlight-style command search
const [spotlightOpen, setSpotlightOpen] = createSignal(false);
const [searchQuery, setSearchQuery] = createSignal('');

// Command revealed from Spotlight — flashes briefly so the user can spot the row.
const [highlightedCmd, setHighlightedCmdSignal] = createSignal<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | undefined;

function setHighlightedCmd(cmdId: string | null) {
  clearTimeout(highlightTimer);
  setHighlightedCmdSignal(cmdId);
  if (cmdId) {
    highlightTimer = setTimeout(() => setHighlightedCmdSignal(null), 2000);
  }
}

// Command whose terminal is blown up to fill the window. Only one at a time —
// a single signal is the enforcement, not a per-row flag.
const [maximizedCmd, setMaximizedCmdSignal] = createSignal<string | null>(null);

/** Maximizes a command (expanding its terminal), or restores when passed null. */
function setMaximizedCmd(cmdId: string | null) {
  if (cmdId) updateCmdState(cmdId, { collapsed: false });
  setMaximizedCmdSignal(cmdId);
}

// Environments of the selected project (loaded from Go, which owns the secrets file)
const [projectEnvs, setProjectEnvs] = createSignal<ProjectEnvs>({ environments: [], activeId: '' });
const [envModalOpen, setEnvModalOpen] = createSignal(false);

// Keyboard shortcuts help modal (opened from the Help menu / ⌘/)
const [shortcutsModalOpen, setShortcutsModalOpen] = createSignal(false);

// Which main view is showing. Dashboard and Discovery are app-wide rather than
// per-project, so they replace both the command list and the (meaningless there)
// groups column.
const [activeView, setActiveView] = createSignal<'commands' | 'dashboard' | 'discovery'>('commands');

// Discovery landscape. The seed lives here rather than in the panel so leaving
// the view and coming back shows the same world instead of silently rerolling.
const [discoverySeed, setDiscoverySeed] = createSignal(20260806);
const [discoveryMotion, setDiscoveryMotion] = createSignal(true);

// Global settings modal (opened from View → Settings… / ⌘,)
const [settingsModalOpen, setSettingsModalOpen] = createSignal(false);
const [appSettings, setAppSettings] = createSignal<AppSettings>({
  schemaVersion: 1,
  metricsEnabled: false,
  retentionDays: 365,
  panels: ['stats', 'memory', 'frequency', 'activity'],
});

// Dashboard controls. Memory vs CPU is not a toggle — both charts render, and
// the Settings panel list is what turns either off.
const [dashGroupBy, setDashGroupBy] = createSignal<MetricGroupBy>('command');
const [dashRangeDays, setDashRangeDays] = createSignal(1);

// Dashboard data
const [metricsResult, setMetricsResult] = createSignal<MetricsResult | null>(null);
const [frequencyResult, setFrequencyResult] = createSignal<FrequencyResult | null>(null);
const [activityHeatmap, setActivityHeatmap] = createSignal<ActivityHeatmap | null>(null);
const [dashLoading, setDashLoading] = createSignal(false);
const [dashError, setDashError] = createSignal('');

// Per-command terminal state
const [cmdState, setCmdState] = createSignal<Map<string, CmdState>>(new Map(), { equals: false });

// Per-shortcut execution state
const [shortcutState, setShortcutState] = createSignal<Map<string, ShortcutState>>(new Map(), { equals: false });

// Wails event listener unsubscribers
const listeners = new Map<string, { offOutput: () => void; offDone: () => void; offPostDone: (() => void) | null }>();

// Layout
const [sidebarWidth, setSidebarWidth] = createSignal(220);
const [groupsWidth, setGroupsWidth] = createSignal(220);
const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
const [groupsCollapsed, setGroupsCollapsed] = createSignal(false);

// Per-command resource stats (updated by resource-stats event)
const [resourceStats, setResourceStats] = createSignal<Map<string, ProcessStats>>(new Map(), { equals: false });

// Modal state
const [editingCmd, setEditingCmd] = createSignal<string | null>(null);
const [editingShortcut, setEditingShortcut] = createSignal<string | null>(null);
const [settingsProjectId, setSettingsProjectId] = createSignal<string | null>(null);

// Derived
const selectedProject = createMemo(() => projects.find(p => p.id === selectedId()) || null);

const visibleGroups = createMemo(() => {
  const proj = selectedProject();
  if (!proj) return [];
  const stored = proj.groups || [];
  const derived = (proj.commands || []).map(c => c.group).filter(Boolean);
  return [...new Set([...stored, ...derived])].sort();
});

// Commands shown in the main panel — filtered by the selected group only.
// Search is global and lives in the Spotlight overlay, not in this list.
const filteredCommands = createMemo(() => {
  const proj = selectedProject();
  if (!proj) return [];
  const group = selectedGroup();
  return group === 'All' ? proj.commands : proj.commands.filter(c => c.group === group);
});

// The environment currently applied to command runs, or null if none.
const activeEnv = createMemo(() => {
  const { environments, activeId } = projectEnvs();
  return environments.find(e => e.id === activeId) || null;
});

const activeEnvVarCount = createMemo(() => activeEnv()?.vars?.length || 0);

/** Loads the environments of a project into the store (empty on failure). */
async function loadProjectEnvs(projectId: string | null, fetch: (id: string) => Promise<ProjectEnvs>) {
  if (!projectId) {
    setProjectEnvs({ environments: [], activeId: '' });
    return;
  }
  try {
    const envs = await fetch(projectId);
    setProjectEnvs({ environments: envs?.environments || [], activeId: envs?.activeId || '' });
  } catch {
    setProjectEnvs({ environments: [], activeId: '' });
  }
}

/**
 * Loads the global settings. Fetchers are injected rather than imported so this
 * module stays free of the Wails global and testable in isolation, matching
 * loadProjectEnvs above.
 */
async function loadAppSettings(fetch: () => Promise<AppSettings>) {
  try {
    const s = await fetch();
    if (s) setAppSettings({ ...s, panels: s.panels || [] });
  } catch {
    // Settings are a convenience; the defaults above already apply.
  }
}

interface DashboardFetchers {
  metrics: (req: MetricsQuery) => Promise<MetricsResult>;
  frequency: (req: MetricsQuery) => Promise<FrequencyResult>;
  activity: (days: number) => Promise<ActivityHeatmap>;
}

interface DashboardOptions {
  groupBy: MetricGroupBy;
  rangeDays: number;
  heatmapDays?: number;
}

/**
 * Loads everything the dashboard renders. Both requests are issued together so
 * one slow read does not stall the other.
 */
async function loadDashboard(fetchers: DashboardFetchers, opts: DashboardOptions) {
  setDashLoading(true);
  setDashError('');

  const to = Math.floor(Date.now() / 1000);
  const from = to - opts.rangeDays * 86400;

  try {
    const [metrics, frequency, activity] = await Promise.all([
      // The memory profile bins its points by footprint, so more samples make
      // the frequency counts better rather than the chart denser — the default
      // point budget is the right one here.
      fetchers.metrics({ from, to, groupBy: opts.groupBy }),
      fetchers.frequency({ from, to, groupBy: opts.groupBy }),
      fetchers.activity(opts.heatmapDays ?? 365),
    ]);
    setMetricsResult(metrics ?? null);
    setFrequencyResult(frequency ?? null);
    setActivityHeatmap(activity ?? null);
    setDashError(metrics?.error || frequency?.error || activity?.error || '');
  } catch (e) {
    setMetricsResult(null);
    setFrequencyResult(null);
    setActivityHeatmap(null);
    setDashError(e instanceof Error ? e.message : String(e));
  } finally {
    setDashLoading(false);
  }
}

export type { EnvVar };

const runningCount = createMemo(() => {
  let count = 0;
  for (const [, s] of cmdState()) {
    if (s.running) count++;
  }
  return count;
});

function projectRunningCount(projectId: string): number {
  const proj = projects.find(p => p.id === projectId);
  if (!proj) return 0;
  const cs = cmdState();
  let count = 0;
  for (const cmd of proj.commands) {
    if (cs.get(cmd.id)?.running) count++;
  }
  return count;
}

function getCmdState(cmdId: string): CmdState {
  return cmdState().get(cmdId) || { ...DEFAULT_CMD_STATE };
}

function updateCmdState(cmdId: string, updater: Partial<CmdState> | ((prev: CmdState) => CmdState)) {
  setCmdState(prev => {
    const map = new Map(prev);
    const current = map.get(cmdId) || { ...DEFAULT_CMD_STATE };
    const updated = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
    map.set(cmdId, updated);
    return map;
  });
}

function getShortcutState(scId: string): ShortcutState {
  return shortcutState().get(scId) || { ...DEFAULT_SC_STATE };
}

function updateShortcutState(scId: string, updater: Partial<ShortcutState> | ((prev: ShortcutState) => ShortcutState)) {
  setShortcutState(prev => {
    const map = new Map(prev);
    const current = map.get(scId) || { ...DEFAULT_SC_STATE };
    const updated = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
    map.set(scId, updated);
    return map;
  });
}

export {
  projects, setProjects,
  selectedId, setSelectedId,
  selectedGroup, setSelectedGroup,
  cmdState, setCmdState, getCmdState, updateCmdState,
  shortcutState, setShortcutState, getShortcutState, updateShortcutState,
  listeners,
  sidebarWidth, setSidebarWidth,
  groupsWidth, setGroupsWidth,
  sidebarCollapsed, setSidebarCollapsed,
  groupsCollapsed, setGroupsCollapsed,
  editingCmd, setEditingCmd,
  editingShortcut, setEditingShortcut,
  settingsProjectId, setSettingsProjectId,
  selectedProject, visibleGroups, filteredCommands,
  runningCount, projectRunningCount,
  resourceStats, setResourceStats,
  searchQuery, setSearchQuery,
  spotlightOpen, setSpotlightOpen,
  highlightedCmd, setHighlightedCmd,
  maximizedCmd, setMaximizedCmd,
  projectEnvs, setProjectEnvs, loadProjectEnvs,
  envModalOpen, setEnvModalOpen,
  shortcutsModalOpen, setShortcutsModalOpen,
  activeEnv, activeEnvVarCount,
  activeView, setActiveView,
  discoverySeed, setDiscoverySeed,
  discoveryMotion, setDiscoveryMotion,
  settingsModalOpen, setSettingsModalOpen,
  appSettings, setAppSettings, loadAppSettings,
  dashGroupBy, setDashGroupBy,
  dashRangeDays, setDashRangeDays,
  metricsResult, setMetricsResult,
  frequencyResult, setFrequencyResult,
  activityHeatmap, setActivityHeatmap,
  dashLoading, setDashLoading,
  dashError, setDashError,
  loadDashboard,
};
