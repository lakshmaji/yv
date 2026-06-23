export const go = window['go']['main']['App'];
export const runtime = window.runtime;

export let projects = [];
export function setProjects(p) { projects = p; }

export let selectedId = null;
export function setSelectedId(id) { selectedId = id; }

export let selectedGroup = 'All';
export function setSelectedGroup(g) { selectedGroup = g; }

export let sidebarWidth = 220;
export function setSidebarWidth(w) { sidebarWidth = w; }

export let groupsWidth = 140;
export function setGroupsWidth(w) { groupsWidth = w; }

export let sidebarCollapsed = false;
export function setSidebarCollapsed(v) { sidebarCollapsed = v; }

// per cmdID: { lines: string[], collapsed: bool, exitCode: number|null, stopped: bool, running: bool }
export const cmdState = new Map();

// tracks active Wails event unsubscribers to avoid duplicate listeners
export const listeners = new Map();

export let currentEditCmdId = null;
export function setCurrentEditCmdId(id) { currentEditCmdId = id; }

export let currentEditShortcutId = null;
export function setCurrentEditShortcutId(id) { currentEditShortcutId = id; }

export let currentSettingsProjectId = null;
export function setCurrentSettingsProjectId(id) { currentSettingsProjectId = id; }
