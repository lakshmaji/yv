import { createSignal, createMemo } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { Project, CmdState, ShortcutState, ProcessStats, ProjectEnvs, EnvVar } from './types';

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

// Environments of the selected project (loaded from Go, which owns the secrets file)
const [projectEnvs, setProjectEnvs] = createSignal<ProjectEnvs>({ environments: [], activeId: '' });
const [envModalOpen, setEnvModalOpen] = createSignal(false);

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
  editingCmd, setEditingCmd,
  editingShortcut, setEditingShortcut,
  settingsProjectId, setSettingsProjectId,
  selectedProject, visibleGroups, filteredCommands,
  runningCount, projectRunningCount,
  resourceStats, setResourceStats,
  searchQuery, setSearchQuery,
  spotlightOpen, setSpotlightOpen,
  highlightedCmd, setHighlightedCmd,
  projectEnvs, setProjectEnvs, loadProjectEnvs,
  envModalOpen, setEnvModalOpen,
  activeEnv, activeEnvVarCount,
};
