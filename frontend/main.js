// Wails v2: window['go']['main']['App']['Method'](args) → Promise
const go = window['go']['main']['App'];
const runtime = window.runtime;

// ── State ──────────────────────────────────────────────────────────────────
let projects = [];
let selectedId = null;
let selectedGroup = 'All';

let sidebarWidth = 220;
let groupsWidth  = 140;
let sidebarCollapsed = false;

// per cmdID: { lines: string[], collapsed: bool, exitCode: number|null }
const cmdState = new Map();

// track active Wails event unsubscribers to avoid duplicate listeners
const listeners = new Map(); // cmdID → { offOutput, offDone }

// ── Helpers ────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lineHtml(line) {
  const e = escHtml(line);
  if (/\b(error|Error|ERROR|exception|Exception|EXCEPTION|fatal|Fatal|FATAL|failed|Failed|FAILED|ENOENT|EACCES|ECONNREFUSED)\b/.test(line)) {
    return `<span class="line-error">${e}</span>\n`;
  }
  if (/\b(warning|Warning|WARNING|warn|Warn|WARN|deprecated|Deprecated)\b/.test(line)) {
    return `<span class="line-warn">${e}</span>\n`;
  }
  if (/^\s+at /.test(line)) {
    return `<span class="line-stack">${e}</span>\n`;
  }
  return e + '\n';
}

function uid() {
  return crypto.randomUUID();
}

function selectedProject() {
  return projects.find(p => p.id === selectedId) || null;
}

// ── Sidebar collapse ───────────────────────────────────────────────────────
function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('sidebar-toggle-btn');
  sidebar.classList.toggle('collapsed', sidebarCollapsed);
  btn.textContent = sidebarCollapsed ? '›' : '‹';
  btn.title = sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
  applyColumnWidths();
}

// ── Sidebar rendering ──────────────────────────────────────────────────────
function renderSidebar() {
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
    `;
    item.addEventListener('click', () => selectProject(p.id));
    list.appendChild(item);
  }
}

function selectProject(id) {
  selectedId = id;
  selectedGroup = 'All';
  renderSidebar();
  renderGroups();
  renderMain();
}

// ── Groups panel rendering ─────────────────────────────────────────────────
function renderGroups() {
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
      selectedGroup = g;
      renderGroups();
      renderMain();
    });
    list.appendChild(item);
  }
}

// ── Main panel rendering ───────────────────────────────────────────────────
function renderMain() {
  const main = document.getElementById('main');
  const proj = selectedProject();

  if (!proj) {
    main.innerHTML = '<div id="no-project">Select or create a project</div>';
    return;
  }

  const groupDefault = selectedGroup !== 'All' ? selectedGroup : '';

  main.innerHTML = `
    <div id="project-header">
      <span id="project-title">${escHtml(proj.name)}</span>
      <span id="project-path">${escHtml(proj.workingDir)}</span>
    </div>
    <div id="commands-list"></div>
    <form id="add-cmd-form" autocomplete="off">
      <input id="add-cmd-label"   placeholder="Label" required />
      <input id="add-cmd-group"   placeholder="Group" value="${escHtml(groupDefault)}" />
      <input id="add-cmd-command" placeholder="shell command…" required />
      <button id="add-cmd-submit" type="submit">+ Add Command</button>
      <div class="add-cmd-dir-row">
        <input id="add-cmd-dir" placeholder="Working dir (optional, defaults to project path)" />
        <button class="add-cmd-dir-pick" type="button" id="add-cmd-dir-pick">Browse</button>
      </div>
    </form>
  `;

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

  document.getElementById('add-cmd-dir-pick').addEventListener('click', async () => {
    const path = await go.PickFolder();
    if (path) document.getElementById('add-cmd-dir').value = path;
  });
}

// ── Command row DOM builder ────────────────────────────────────────────────
function buildCmdRow(cmd) {
  if (!cmdState.has(cmd.id)) {
    cmdState.set(cmd.id, { lines: [], collapsed: true, exitCode: null, stopped: false });
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
  row.className = rowClass;
  row.id = 'row-' + cmd.id;

  row.innerHTML = `
    <div class="cmd-header" data-cmdid="${escHtml(cmd.id)}">
      <span class="chevron">▶</span>
      <span class="cmd-label">${escHtml(cmd.label)}</span>
      <span class="cmd-snippet" title="${escHtml(cmd.command)}">${escHtml(cmd.command)}</span>
      ${cmd.workingDir ? `<span class="cmd-dir" title="${escHtml(cmd.workingDir)}">${escHtml(cmd.workingDir)}</span>` : ''}
      <span class="line-hint" id="hint-${escHtml(cmd.id)}" style="display:none"></span>
      <div class="cmd-actions">
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

  // chevron / header click → toggle collapse
  row.querySelector('.cmd-header').addEventListener('click', e => {
    if (e.target.closest('.cmd-actions')) return;
    toggleTerminal(cmd.id);
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

// ── Terminal collapse/expand ───────────────────────────────────────────────
function toggleTerminal(cmdId) {
  const state = cmdState.get(cmdId);
  if (!state) return;
  state.collapsed = !state.collapsed;
  applyTerminalState(cmdId);
}

function expandTerminal(cmdId) {
  const state = cmdState.get(cmdId);
  if (!state) return;
  state.collapsed = false;
  applyTerminalState(cmdId);
}

function applyTerminalState(cmdId) {
  const row = document.getElementById('row-' + cmdId);
  if (!row) return;
  const state = cmdState.get(cmdId);
  const hasContent = state.lines.length > 0;

  if (!state.collapsed && hasContent) {
    row.classList.add('expanded');
  } else {
    row.classList.remove('expanded');
  }

  const hint = document.getElementById('hint-' + cmdId);
  if (hint) {
    if (state.collapsed && hasContent) {
      hint.textContent = state.lines.length + ' lines';
      hint.style.display = '';
    } else {
      hint.style.display = 'none';
    }
  }
}

function clearTerminal(cmdId) {
  const state = cmdState.get(cmdId);
  if (state) {
    state.lines = [];
    state.exitCode = null;
    state.collapsed = true;
    state.stopped = false;
  }
  const out = document.getElementById('output-' + cmdId);
  if (out) out.textContent = '';
  const badge = document.getElementById('exit-' + cmdId);
  if (badge) { badge.style.display = 'none'; badge.textContent = ''; badge.className = 'exit-badge'; }
  const row = document.getElementById('row-' + cmdId);
  if (row) row.classList.remove('done-ok', 'done-err', 'done-stopped');
  applyTerminalState(cmdId);
}

// ── Command execution ──────────────────────────────────────────────────────
async function runCommand(cmd) {
  const proj = selectedProject();
  if (!proj) return;

  // tear down prior listeners for this cmd
  teardownListeners(cmd.id);

  // reset terminal state and keep expanded
  const state = cmdState.get(cmd.id) || { lines: [], collapsed: false, exitCode: null, stopped: false };
  state.lines = [];
  state.collapsed = false;
  state.exitCode = null;
  state.stopped = false;
  cmdState.set(cmd.id, state);
  const row = document.getElementById('row-' + cmd.id);
  if (row) row.classList.remove('done-ok', 'done-err', 'done-stopped');

  const out = document.getElementById('output-' + cmd.id);
  if (out) out.textContent = '';
  const badge = document.getElementById('exit-' + cmd.id);
  if (badge) { badge.style.display = 'none'; badge.className = 'exit-badge'; }

  setRowRunning(cmd.id, true);
  expandTerminal(cmd.id);

  // wire up streaming events
  const offOutput = runtime.EventsOn('output:' + cmd.id, line => {
    appendLine(cmd.id, line);
  });

  const offDone = runtime.EventsOn('done:' + cmd.id, result => {
    teardownListeners(cmd.id);
    setRowRunning(cmd.id, false);
    showExitBadge(cmd.id, result);
    const s = cmdState.get(cmd.id);
    const wasStopped = s && s.stopped;
    if (s) s.exitCode = result.exitCode;
    const row = document.getElementById('row-' + cmd.id);
    if (row) {
      row.classList.remove('running');
      if (result.exitCode === 0) {
        row.classList.add('done-ok');
      } else if (wasStopped) {
        row.classList.add('done-stopped');
        if (s) s.collapsed = true;
        row.classList.remove('expanded');
      } else {
        row.classList.add('done-err');
        if (s) s.collapsed = true;
        row.classList.remove('expanded');
      }
    }
  });

  listeners.set(cmd.id, { offOutput, offDone });

  try {
    await go.ExecuteCommand(cmd, proj.workingDir);
  } catch (err) {
    appendLine(cmd.id, 'ERROR: ' + err);
    setRowRunning(cmd.id, false);
    teardownListeners(cmd.id);
  }
}

function appendLine(cmdId, line) {
  const state = cmdState.get(cmdId);
  if (state) state.lines.push(line);

  const out = document.getElementById('output-' + cmdId);
  if (!out) return;
  out.insertAdjacentHTML('beforeend', lineHtml(line));
  out.scrollTop = out.scrollHeight;

  // update line hint if collapsed
  applyTerminalState(cmdId);
}

function showExitBadge(cmdId, result) {
  const badge = document.getElementById('exit-' + cmdId);
  if (!badge) return;
  const ok = result.exitCode === 0 && !result.error;
  badge.textContent = ok ? 'exited 0' : `exited ${result.exitCode}${result.error ? ': ' + result.error : ''}`;
  badge.className = 'exit-badge ' + (ok ? 'exit-ok' : 'exit-err');
  badge.style.display = '';
}

function setRowRunning(cmdId, running) {
  const row = document.getElementById('row-' + cmdId);
  if (!row) return;
  if (running) {
    row.classList.add('running');
    row.classList.remove('done-ok', 'done-err', 'done-stopped', 'stopping');
  } else {
    row.classList.remove('running', 'stopping');
  }
}

function teardownListeners(cmdId) {
  const existing = listeners.get(cmdId);
  if (existing) {
    if (typeof existing.offOutput === 'function') existing.offOutput();
    if (typeof existing.offDone === 'function') existing.offDone();
    listeners.delete(cmdId);
  }
}

// ── Add command ────────────────────────────────────────────────────────────
async function addCommand() {
  const proj = selectedProject();
  if (!proj) return;

  const labelEl   = document.getElementById('add-cmd-label');
  const groupEl   = document.getElementById('add-cmd-group');
  const commandEl = document.getElementById('add-cmd-command');
  const dirEl     = document.getElementById('add-cmd-dir');

  const label   = labelEl.value.trim();
  const group   = groupEl.value.trim();
  const command = commandEl.value.trim();
  const workingDir = dirEl ? dirEl.value.trim() : '';
  if (!label || !command) return;

  const newCmd = { id: uid(), label, command, group, workingDir };
  proj.commands.push(newCmd);

  const result = await go.SaveProjects(projects);
  if (result !== 'ok') {
    alert('Save failed: ' + result);
    proj.commands.pop();
    return;
  }

  labelEl.value = '';
  commandEl.value = '';
  if (dirEl) dirEl.value = '';
  renderGroups();
  renderMain();
}

// ── Add group ─────────────────────────────────────────────────────────────
async function addGroup(name) {
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

// ── Resize panels ─────────────────────────────────────────────────────────
function applyColumnWidths() {
  const sw = sidebarCollapsed ? 48 : sidebarWidth;
  document.body.style.gridTemplateColumns = `${sw}px ${groupsWidth}px 1fr`;
}

function initResize(handleId, getWidth, setWidth) {
  const handle = document.getElementById(handleId);
  if (!handle) return;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = getWidth();
    handle.classList.add('dragging');
    const onMove = e => {
      setWidth(Math.max(80, startW + (e.clientX - startX)));
      applyColumnWidths();
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── New project ────────────────────────────────────────────────────────────
document.getElementById('add-project-btn').addEventListener('click', () => {
  const form = document.getElementById('new-project-form');
  form.classList.toggle('visible');
  if (form.classList.contains('visible')) {
    document.getElementById('np-name').focus();
  }
});

document.getElementById('np-cancel').addEventListener('click', () => {
  document.getElementById('new-project-form').classList.remove('visible');
  document.getElementById('np-name').value = '';
  document.getElementById('np-dir').value = '';
});

document.getElementById('np-pick').addEventListener('click', async () => {
  const path = await go.PickFolder();
  if (path) document.getElementById('np-dir').value = path;
});

document.getElementById('np-save').addEventListener('click', async () => {
  const name = document.getElementById('np-name').value.trim();
  const dir  = document.getElementById('np-dir').value.trim();
  if (!name || !dir) return;

  const proj = { id: uid(), name, workingDir: dir, commands: [] };
  projects.push(proj);

  const result = await go.SaveProjects(projects);
  if (result !== 'ok') {
    alert('Save failed: ' + result);
    projects.pop();
    return;
  }

  document.getElementById('new-project-form').classList.remove('visible');
  document.getElementById('np-name').value = '';
  document.getElementById('np-dir').value = '';

  selectProject(proj.id);
});

// ── Add group form wiring ──────────────────────────────────────────────────
document.getElementById('add-group-btn').addEventListener('click', () => {
  const form = document.getElementById('add-group-form');
  form.classList.toggle('visible');
  if (form.classList.contains('visible')) {
    document.getElementById('ag-name').focus();
  }
});

document.getElementById('ag-cancel').addEventListener('click', () => {
  document.getElementById('add-group-form').classList.remove('visible');
  document.getElementById('ag-name').value = '';
});

document.getElementById('ag-save').addEventListener('click', async () => {
  const name = document.getElementById('ag-name').value.trim();
  if (!name) return;
  await addGroup(name);
  document.getElementById('add-group-form').classList.remove('visible');
  document.getElementById('ag-name').value = '';
});

document.getElementById('ag-name').addEventListener('keydown', async e => {
  if (e.key === 'Enter') {
    const name = e.target.value.trim();
    if (!name) return;
    await addGroup(name);
    document.getElementById('add-group-form').classList.remove('visible');
    e.target.value = '';
  } else if (e.key === 'Escape') {
    document.getElementById('add-group-form').classList.remove('visible');
    e.target.value = '';
  }
});

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('sidebar-toggle-btn').addEventListener('click', toggleSidebar);

  initResize('rh-sidebar',
    () => sidebarWidth,
    w  => { sidebarWidth = w; }
  );
  initResize('rh-groups',
    () => groupsWidth,
    w  => { groupsWidth = w; }
  );

  try {
    projects = await go.LoadProjects();
  } catch (e) {
    projects = [];
  }
  renderSidebar();
  renderGroups();
  if (projects.length > 0) {
    selectProject(projects[0].id);
  }
});
