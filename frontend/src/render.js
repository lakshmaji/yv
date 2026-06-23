import {
  go, projects,
  selectedId, setSelectedId,
  selectedGroup, setSelectedGroup,
  cmdState,
} from './state.js';
import { escHtml, lineHtml, uid, selectedProject } from './utils.js';
import { toggleTerminal, clearTerminal, teardownListeners, setRowRunning, updateRunningCount } from './terminal.js';
import { runCommand } from './commands.js';
import { openEditModal, openProjectSettings } from './modals.js';
import { renderShortcuts, openShortcutModal } from './shortcuts.js';
import { applyColumnWidths } from './resize.js';

// ── Sidebar ────────────────────────────────────────────────────────────────

export function renderSidebar() {
  const list = document.getElementById('project-list');
  list.innerHTML = '';
  for (const p of projects) {
    const item = document.createElement('div');
    item.className = 'project-item' + (p.id === selectedId ? ' active' : '');
    item.dataset.id = p.id;
    item.title = p.name;
    const initials = escHtml(p.name.slice(0, 2).toUpperCase());
    item.innerHTML = `
      <span class="project-avatar">${initials}</span>
      <span class="project-dot"></span>
      <span class="project-name">${escHtml(p.name)}</span>
      <span class="project-running-count"></span>
      <button class="project-settings-btn" title="Project settings">⚙</button>
    `;
    item.querySelector('.project-settings-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openProjectSettings(p.id);
    });
    item.addEventListener('click', () => selectProject(p.id));
    list.appendChild(item);
  }
}

export function selectProject(id) {
  setSelectedId(id);
  setSelectedGroup('All');
  renderSidebar();
  renderGroups();
  renderMain();
}

// ── Groups panel ───────────────────────────────────────────────────────────

export function renderGroups() {
  const list = document.getElementById('groups-list');
  list.innerHTML = '';

  const proj = selectedProject();
  if (!proj) return;

  const stored  = proj.groups || [];
  const derived = proj.commands.map(c => c.group).filter(Boolean);
  const groups  = [...new Set([...stored, ...derived])].sort();
  const items   = ['All', ...groups];

  for (const g of items) {
    const item = document.createElement('div');
    item.className = 'group-item' + (g === selectedGroup ? ' active' : '');
    item.textContent = g;
    item.addEventListener('click', () => {
      setSelectedGroup(g);
      renderGroups();
      renderMain();
    });
    list.appendChild(item);
  }
}

// ── Main panel ─────────────────────────────────────────────────────────────

export function renderMain() {
  const main = document.getElementById('main');
  const proj = selectedProject();

  if (!proj) {
    main.innerHTML = '<div id="no-project">Select or create a project</div>';
    return;
  }

  const groupDefault = selectedGroup !== 'All' ? selectedGroup : '';
  const isAllGroups = selectedGroup === 'All';
  const displayPath = (!isAllGroups && proj.groupPaths?.[selectedGroup]) || proj.workingDir;

  main.innerHTML = `
    <div id="project-header">
      <span id="project-title">${escHtml(proj.name)}</span>
      <span id="project-path">${escHtml(displayPath)}</span>
      ${!isAllGroups ? `<button id="change-path-btn" type="button">Change Path</button>` : ''}
    </div>
    <div id="shortcuts-section">
      <div class="shortcuts-header">
        <span class="shortcuts-title">Shortcuts</span>
        <button id="add-shortcut-btn">+ New Shortcut</button>
      </div>
      <div id="shortcuts-list"></div>
    </div>
    <div id="commands-list"></div>
    <form id="add-cmd-form" autocomplete="off">
      <input id="add-cmd-label"   placeholder="Label" required />
      <input id="add-cmd-group"   placeholder="Group" value="${escHtml(groupDefault)}" />
      <input id="add-cmd-command" placeholder="shell command…" required />
      <button id="add-cmd-submit" type="submit">+ Add Command</button>
    </form>
  `;

  renderShortcuts(proj);
  document.getElementById('add-shortcut-btn').addEventListener('click', () => openShortcutModal());

  const cmds = selectedGroup === 'All'
    ? proj.commands
    : proj.commands.filter(c => c.group === selectedGroup);

  const list = document.getElementById('commands-list');
  for (const cmd of cmds) {
    list.appendChild(buildCmdRow(cmd));
  }

  document.getElementById('add-cmd-form').addEventListener('submit', e => {
    e.preventDefault();
    addCommand();
  });

  // Re-sync running state from Go backend (safety net for hot-reload)
  go.GetRunningCommands().then(runningIds => {
    const runningSet = new Set(runningIds || []);
    for (const cmd of cmds) {
      const s = cmdState.get(cmd.id);
      if (s && runningSet.has(cmd.id) && !s.running) {
        s.running = true;
        const r = document.getElementById('row-' + cmd.id);
        if (r) r.classList.add('running');
      }
    }
    updateRunningCount();
  });

  if (!isAllGroups) {
    document.getElementById('change-path-btn').addEventListener('click', async () => {
      const proj = selectedProject();
      if (!proj) return;
      const path = await go.PickFolder();
      if (!path) return;
      if (!proj.groupPaths) proj.groupPaths = {};
      proj.groupPaths[selectedGroup] = path;
      const result = await go.SaveProjects(projects);
      if (result !== 'ok') { alert('Save failed: ' + result); return; }
      document.getElementById('project-path').textContent = path;
    });
  }
}

// ── Command row DOM builder ────────────────────────────────────────────────

export function buildCmdRow(cmd) {
  if (!cmdState.has(cmd.id)) {
    cmdState.set(cmd.id, { lines: [], collapsed: true, exitCode: null, stopped: false, running: false });
  }
  const state = cmdState.get(cmd.id);

  const row = document.createElement('div');
  let rowClass = 'cmd-row';
  if (!state.collapsed && state.lines.length) rowClass += ' expanded';
  if (state.exitCode !== null) {
    if (state.exitCode === 0)  rowClass += ' done-ok';
    else if (state.stopped)    rowClass += ' done-stopped';
    else                       rowClass += ' done-err';
  }
  if (state.running) rowClass += ' running';
  row.className = rowClass;
  row.id = 'row-' + cmd.id;

  const preCount  = cmd.preCommands  && cmd.preCommands.length;
  const postCount = cmd.postCommands && cmd.postCommands.length;
  let hookBadge = '';
  if (preCount && postCount) {
    hookBadge = `<span class="pre-count-badge">${preCount} pre · ${postCount} post</span>`;
  } else if (preCount) {
    hookBadge = `<span class="pre-count-badge">${preCount} pre hook${preCount > 1 ? 's' : ''}</span>`;
  } else if (postCount) {
    hookBadge = `<span class="pre-count-badge">${postCount} post hook${postCount > 1 ? 's' : ''}</span>`;
  }
  row.innerHTML = `
    <div class="cmd-header" data-cmdid="${escHtml(cmd.id)}">
      <span class="chevron">▶</span>
      <span class="cmd-spinner"><span class="loader"></span></span>
      <span class="cmd-label">${escHtml(cmd.label)}</span>
      <span class="cmd-snippet" title="${escHtml(cmd.command)}">${escHtml(cmd.command)}</span>
      ${cmd.workingDir ? `<span class="cmd-dir" title="${escHtml(cmd.workingDir)}">${escHtml(cmd.workingDir)}</span>` : ''}
      ${hookBadge}
      <span class="line-hint" id="hint-${escHtml(cmd.id)}" style="display:none"></span>
      <div class="cmd-actions">
        <button class="edit-btn" id="editbtn-${escHtml(cmd.id)}" title="Edit command">✎</button>
        <button class="dismiss-btn" id="dismiss-${escHtml(cmd.id)}">✕ Dismiss</button>
        <button class="run-btn"  id="run-${escHtml(cmd.id)}">▶ Run</button>
        <button class="stop-btn" id="stop-${escHtml(cmd.id)}">■ Stop</button>
      </div>
    </div>
    <div class="cmd-terminal" id="terminal-${escHtml(cmd.id)}">
      <div class="terminal-toolbar">
        <span class="exit-badge" id="exit-${escHtml(cmd.id)}" style="display:none"></span>
        <button class="clear-btn" id="clear-${escHtml(cmd.id)}">Clear</button>
      </div>
      <div class="terminal-output" id="output-${escHtml(cmd.id)}">${state.lines.map(lineHtml).join('')}</div>
    </div>
  `;

  row.querySelector('.cmd-header').addEventListener('click', e => {
    if (e.target.closest('.cmd-actions')) return;
    toggleTerminal(cmd.id);
  });

  row.querySelector('.edit-btn').addEventListener('click', e => {
    e.stopPropagation();
    openEditModal(cmd);
  });

  row.querySelector('.dismiss-btn').addEventListener('click', e => {
    e.stopPropagation();
    const s = cmdState.get(cmd.id);
    if (s) s.collapsed = true;
    row.classList.remove('done-err', 'expanded');
  });

  row.querySelector('.run-btn').addEventListener('click', e => {
    e.stopPropagation();
    runCommand(cmd);
  });

  row.querySelector('.stop-btn').addEventListener('click', async e => {
    e.stopPropagation();
    const r = document.getElementById('row-' + cmd.id);
    if (r) r.classList.add('stopping');
    const s = cmdState.get(cmd.id);
    if (s) s.stopped = true; // mark as user-initiated so offDone uses done-stopped
    const result = await go.StopCommand(cmd.id);
    if (result === 'not running') {
      // process already dead but done: event was missed — unstick the row
      teardownListeners(cmd.id);
      setRowRunning(cmd.id, false);
      if (s) { s.collapsed = true; s.exitCode = -1; }
      if (r) { r.classList.remove('running', 'stopping', 'expanded'); r.classList.add('done-stopped'); }
    }
    // 'stopping' / 'killed': the done: event from Go will handle the rest
  });

  row.querySelector(`#clear-${cmd.id}`).addEventListener('click', e => {
    e.stopPropagation();
    clearTerminal(cmd.id);
  });

  return row;
}

// ── Add command / group ────────────────────────────────────────────────────

export async function addCommand() {
  const proj = selectedProject();
  if (!proj) return;

  const labelEl   = document.getElementById('add-cmd-label');
  const groupEl   = document.getElementById('add-cmd-group');
  const commandEl = document.getElementById('add-cmd-command');

  const label   = labelEl.value.trim();
  const group   = groupEl.value.trim();
  const command = commandEl.value.trim();
  if (!label || !command) return;

  const newCmd = { id: uid(), label, command, group, workingDir: '' };
  proj.commands.push(newCmd);

  const result = await go.SaveProjects(projects);
  if (result !== 'ok') {
    alert('Save failed: ' + result);
    proj.commands.pop();
    return;
  }

  labelEl.value = '';
  commandEl.value = '';
  renderGroups();
  renderMain();
}

export async function addGroup(name) {
  const proj = selectedProject();
  if (!proj) return;

  if (!proj.groups) proj.groups = [];
  if (proj.groups.includes(name)) return;

  proj.groups.push(name);

  const result = await go.SaveProjects(projects);
  if (result !== 'ok') {
    alert('Save failed: ' + result);
    proj.groups.pop();
    return;
  }

  renderGroups();
}
