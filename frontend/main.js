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

let currentEditCmdId = null;

// ── Helpers ────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lineHtml(line) {
  const e = escHtml(line);
  if (/^\[PRE\] /.test(line)) {
    return `<span class="line-pre">${e}</span>\n`;
  }
  if (/^\[POST\] /.test(line)) {
    return `<span class="line-post">${e}</span>\n`;
  }
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
      <span class="project-export-btns">
        <button class="project-export-btn" data-fmt="json" title="Export as JSON">↑ json</button>
        <button class="project-export-btn" data-fmt="yaml" title="Export as YAML">↑ yaml</button>
      </span>
    `;
    item.querySelectorAll('.project-export-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const fmt = btn.dataset.fmt;
        try {
          const result = await go.ExportProject(p.id, fmt);
          if (result) alert('Exported to ' + result);
        } catch (err) {
          alert('Export failed: ' + err);
        }
      });
    });
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
      <div class="add-cmd-dir-row">
        <input id="add-cmd-dir" placeholder="Working dir (optional, defaults to project path)" />
        <button class="add-cmd-dir-pick" type="button" id="add-cmd-dir-pick">Browse</button>
      </div>
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

  // chevron / header click → toggle collapse
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
  if (!proj) return -1;

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

  // Unique ID for this specific run — prevents stale done: events from a prior
  // goroutine (e.g. after a wails dev reload or a re-run) from clearing the Stop button.
  const runID = Date.now() + '-' + Math.random().toString(36).slice(2, 7);

  const hasPostHooks = !!(cmd.postCommands && cmd.postCommands.length);

  const offOutput = runtime.EventsOn('output:' + cmd.id + ':' + runID, line => {
    appendLine(cmd.id, line);
  });

  let resolveDone;
  const donePromise = new Promise(resolve => { resolveDone = resolve; });

  // Shared handler — used by offDone (no post-hooks) or offPostDone (post-hooks).
  function applyFinalResult(result) {
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
    resolveDone(result.exitCode);
  }

  const offDone = runtime.EventsOn('done:' + cmd.id + ':' + runID, result => {
    if (!hasPostHooks) {
      applyFinalResult(result);
    }
    // With post-hooks: done fires when main exits but is not the final event.
    // post-done is always emitted last and drives the final UI state.
  });

  let offPostDone = null;
  if (hasPostHooks) {
    offPostDone = runtime.EventsOn('post-done:' + cmd.id + ':' + runID, result => {
      applyFinalResult(result);
    });
  }

  listeners.set(cmd.id, { offOutput, offDone, offPostDone });

  try {
    await go.ExecuteCommand(cmd, proj.workingDir, runID);
  } catch (err) {
    appendLine(cmd.id, 'ERROR: ' + err);
    setRowRunning(cmd.id, false);
    teardownListeners(cmd.id);
    resolveDone(-1);
  }

  return donePromise;
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
    if (typeof existing.offPostDone === 'function') existing.offPostDone();
    listeners.delete(cmdId);
  }
}

// ── Shortcuts ──────────────────────────────────────────────────────────────
async function runShortcut(shortcut) {
  const proj = selectedProject();
  if (!proj) return;

  setShortcutRunning(shortcut.id, true);

  for (let i = 0; i < shortcut.commandIds.length; i++) {
    const cmd = proj.commands.find(c => c.id === shortcut.commandIds[i]);
    if (!cmd) continue;

    setShortcutStep(shortcut.id, i, 'running');
    document.getElementById('row-' + cmd.id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const exitCode = await runCommand(cmd);

    if (exitCode !== 0) {
      setShortcutStep(shortcut.id, i, 'failed');
      for (let j = i + 1; j < shortcut.commandIds.length; j++) {
        setShortcutStep(shortcut.id, j, 'skipped');
      }
      setShortcutRunning(shortcut.id, false, 'failed');
      return;
    }
    setShortcutStep(shortcut.id, i, 'ok');
  }

  setShortcutRunning(shortcut.id, false, 'ok');
}

function setShortcutRunning(shortcutId, running, finalState) {
  const card = document.getElementById('shortcut-' + shortcutId);
  if (!card) return;
  const btn = card.querySelector('.sc-run-btn');
  if (running) {
    card.classList.add('sc-running');
    card.classList.remove('sc-ok', 'sc-failed');
    if (btn) btn.disabled = true;
  } else {
    card.classList.remove('sc-running');
    if (finalState) card.classList.add('sc-' + finalState);
    if (btn) btn.disabled = false;
  }
}

function setShortcutStep(shortcutId, stepIndex, state) {
  const pill = document.querySelector(
    '#shortcut-' + shortcutId + ' .sc-step[data-index="' + stepIndex + '"]'
  );
  if (pill) pill.className = 'sc-step sc-step-' + state;
}

function renderShortcuts(proj) {
  const list = document.getElementById('shortcuts-list');
  if (!list) return;
  list.innerHTML = '';
  if (!proj || !proj.shortcuts) return;
  for (const sc of proj.shortcuts) {
    list.appendChild(buildShortcutCard(sc, proj));
  }
}

function buildShortcutCard(sc, proj) {
  const card = document.createElement('div');
  card.className = 'shortcut-card';
  card.id = 'shortcut-' + sc.id;

  const steps = sc.commandIds.map((cid, idx) => {
    const cmd = proj.commands.find(c => c.id === cid);
    const label = cmd ? escHtml(cmd.label) : '<em class="sc-missing">deleted</em>';
    return `<span class="sc-step" data-index="${idx}">${label}</span>`;
  }).join('<span class="sc-arrow">→</span>');

  card.innerHTML = `
    <div class="shortcut-row">
      <span class="sc-name">${escHtml(sc.name)}</span>
      <div class="sc-steps">${steps}</div>
      <div class="sc-actions">
        <button class="sc-edit-btn" title="Edit shortcut">✎</button>
        <button class="sc-delete-btn" title="Delete shortcut">✕</button>
        <button class="sc-run-btn">▶ Run</button>
      </div>
    </div>
  `;

  card.querySelector('.sc-run-btn').addEventListener('click', e => {
    e.stopPropagation();
    runShortcut(sc);
  });
  card.querySelector('.sc-edit-btn').addEventListener('click', e => {
    e.stopPropagation();
    openShortcutModal(sc);
  });
  card.querySelector('.sc-delete-btn').addEventListener('click', async e => {
    e.stopPropagation();
    await deleteShortcut(sc.id);
  });

  return card;
}

let currentEditShortcutId = null;

function openShortcutModal(sc) {
  const proj = selectedProject();
  if (!proj) return;
  currentEditShortcutId = sc ? sc.id : null;
  document.getElementById('sc-modal-title').textContent = sc ? 'Edit Shortcut' : 'New Shortcut';
  document.getElementById('sc-name-input').value = sc ? sc.name : '';
  const container = document.getElementById('sc-cmd-checkboxes');
  container.innerHTML = '';

  // When editing, render in saved order first, then append unchecked ones
  const orderedCmds = sc
    ? [
        ...sc.commandIds.map(id => proj.commands.find(c => c.id === id)).filter(Boolean),
        ...proj.commands.filter(c => !sc.commandIds.includes(c.id)),
      ]
    : proj.commands;

  for (const cmd of orderedCmds) {
    const checked = sc && sc.commandIds.includes(cmd.id) ? 'checked' : '';
    const cbId = 'sc-cb-' + cmd.id;
    const row = document.createElement('div');
    row.className = 'sc-cmd-checkbox-row';
    row.innerHTML = `
      <span class="sc-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
      <label class="sc-cmd-cb-label-wrap" for="${cbId}">
        <input type="checkbox" class="sc-cmd-cb" id="${cbId}" value="${escHtml(cmd.id)}" ${checked}>
        <span class="sc-cmd-cb-label">${escHtml(cmd.label)}</span>
      </label>
      <span class="sc-cmd-cb-snippet">${escHtml(cmd.command)}</span>
    `;
    container.appendChild(row);
  }

  initShortcutDrag(container);
  document.getElementById('sc-modal').style.display = 'flex';
  document.getElementById('sc-name-input').focus();
}

function initShortcutDrag(container) {
  let dragging = null;

  container.addEventListener('dragstart', e => {
    const handle = e.target.closest('.sc-drag-handle');
    if (!handle) { e.preventDefault(); return; }
    dragging = handle.closest('.sc-cmd-checkbox-row');
    if (!dragging) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(dragging, 20, dragging.offsetHeight / 2);
    setTimeout(() => dragging.classList.add('sc-dragging'), 0);
  });

  container.addEventListener('dragover', e => {
    e.preventDefault();
    if (!dragging) return;
    const target = e.target.closest('.sc-cmd-checkbox-row');
    if (!target || target === dragging) return;
    const rect = target.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      container.insertBefore(dragging, target);
    } else {
      container.insertBefore(dragging, target.nextSibling);
    }
  });

  container.addEventListener('dragend', () => {
    if (dragging) dragging.classList.remove('sc-dragging');
    dragging = null;
  });
}

function closeShortcutModal() {
  document.getElementById('sc-modal').style.display = 'none';
  currentEditShortcutId = null;
}

async function saveShortcut() {
  const proj = selectedProject();
  if (!proj) return;
  const name = document.getElementById('sc-name-input').value.trim();
  if (!name) return;
  // Read in current DOM order so drag-reordering is respected
  const commandIds = Array.from(
    document.querySelectorAll('#sc-cmd-checkboxes .sc-cmd-checkbox-row')
  ).filter(row => row.querySelector('.sc-cmd-cb')?.checked)
   .map(row => row.querySelector('.sc-cmd-cb').value);
  if (commandIds.length === 0) { alert('Select at least one command.'); return; }
  if (!proj.shortcuts) proj.shortcuts = [];
  if (currentEditShortcutId) {
    const sc = proj.shortcuts.find(s => s.id === currentEditShortcutId);
    if (sc) { sc.name = name; sc.commandIds = commandIds; }
  } else {
    proj.shortcuts.push({ id: uid(), name, commandIds });
  }
  const result = await go.SaveProjects(projects);
  if (result !== 'ok') { alert('Save failed: ' + result); return; }
  closeShortcutModal();
  renderMain();
}

async function deleteShortcut(id) {
  const proj = selectedProject();
  if (!proj || !proj.shortcuts) return;
  proj.shortcuts = proj.shortcuts.filter(s => s.id !== id);
  const result = await go.SaveProjects(projects);
  if (result !== 'ok') { alert('Save failed: ' + result); return; }
  renderMain();
}

// ── Edit command modal ─────────────────────────────────────────────────────
function addPreHookRow(value = '') {
  const list = document.getElementById('pre-hooks-list');
  const row = document.createElement('div');
  row.className = 'pre-hook-row';
  row.innerHTML = `
    <input class="pre-hook-input" placeholder="shell command…" value="${escHtml(value)}" />
    <button class="pre-hook-del-btn" type="button">✕</button>
  `;
  row.querySelector('.pre-hook-del-btn').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

function addPostHookRow(command = '', timeout = '') {
  const list = document.getElementById('post-hooks-list');
  const row = document.createElement('div');
  row.className = 'post-hook-row';
  const timeoutVal = timeout ? escHtml(String(timeout)) : '';
  row.innerHTML = `
    <input class="post-hook-input" placeholder="shell command…" value="${escHtml(command)}" />
    <input class="post-hook-timeout" type="number" placeholder="120" value="${timeoutVal}" min="1" max="3600" title="Timeout in seconds (default: 120)" />
    <span class="post-hook-timeout-label">s</span>
    <button class="pre-hook-del-btn" type="button">✕</button>
  `;
  row.querySelector('.pre-hook-del-btn').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

function openEditModal(cmd) {
  currentEditCmdId = cmd.id;
  document.getElementById('edit-label').value   = cmd.label || '';
  document.getElementById('edit-group').value   = cmd.group || '';
  document.getElementById('edit-command').value = cmd.command || '';
  document.getElementById('edit-dir').value     = cmd.workingDir || '';

  const list = document.getElementById('pre-hooks-list');
  list.innerHTML = '';
  for (const pre of (cmd.preCommands || [])) {
    addPreHookRow(pre);
  }

  const postList = document.getElementById('post-hooks-list');
  postList.innerHTML = '';
  for (const post of (cmd.postCommands || [])) {
    addPostHookRow(post.command, post.timeout || '');
  }

  document.getElementById('edit-cmd-modal').style.display = 'flex';
  document.getElementById('edit-label').focus();
}

function closeEditModal() {
  document.getElementById('edit-cmd-modal').style.display = 'none';
  currentEditCmdId = null;
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

// ── Export / Import ────────────────────────────────────────────────────────
document.getElementById('btn-export').addEventListener('click', async () => {
  try {
    const path = await go.ExportProjects()
    if (path) alert(`Exported to ${path}`)
  } catch (err) {
    alert('Export failed: ' + err)
  }
})

document.getElementById('btn-import').addEventListener('click', async () => {
  try {
    const msg = await go.ImportProjects()
    if (!msg) return // cancelled
    projects = await go.LoadProjects()
    renderSidebar()
    renderGroups()
    renderMain()
    alert(msg)
  } catch (err) {
    alert('Import failed: ' + err)
  }
})

document.getElementById('btn-import-project').addEventListener('click', async () => {
  try {
    const msg = await go.ImportProject()
    if (!msg) return // cancelled
    projects = await go.LoadProjects()
    renderSidebar()
    renderGroups()
    renderMain()
    alert(msg)
  } catch (err) {
    alert('Import failed: ' + err)
  }
})

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Edit modal wiring
  document.getElementById('edit-cancel-btn').addEventListener('click', closeEditModal);

  document.getElementById('edit-cmd-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('edit-cmd-modal')) closeEditModal();
  });

  document.getElementById('edit-dir-pick').addEventListener('click', async () => {
    const path = await go.PickFolder();
    if (path) document.getElementById('edit-dir').value = path;
  });

  document.getElementById('add-pre-hook-btn').addEventListener('click', () => addPreHookRow());
  document.getElementById('add-post-hook-btn').addEventListener('click', () => addPostHookRow());

  document.getElementById('edit-save-btn').addEventListener('click', async () => {
    if (!currentEditCmdId) return;
    const proj = selectedProject();
    if (!proj) return;
    const cmd = proj.commands.find(c => c.id === currentEditCmdId);
    if (!cmd) return;

    const label      = document.getElementById('edit-label').value.trim();
    const group      = document.getElementById('edit-group').value.trim();
    const command    = document.getElementById('edit-command').value.trim();
    const workingDir = document.getElementById('edit-dir').value.trim();
    if (!label || !command) return;

    const preCommands = Array.from(
      document.querySelectorAll('#pre-hooks-list .pre-hook-input')
    ).map(i => i.value.trim()).filter(Boolean);

    const postCommands = Array.from(
      document.querySelectorAll('#post-hooks-list .post-hook-row')
    ).map(row => {
      const command = row.querySelector('.post-hook-input').value.trim();
      const t = row.querySelector('.post-hook-timeout').value.trim();
      const timeout = t ? parseInt(t, 10) : 0;
      return command ? { command, timeout: timeout > 0 ? timeout : 0 } : null;
    }).filter(Boolean);

    cmd.label        = label;
    cmd.group        = group;
    cmd.command      = command;
    cmd.workingDir   = workingDir;
    cmd.preCommands  = preCommands;
    cmd.postCommands = postCommands;

    const result = await go.SaveProjects(projects);
    if (result !== 'ok') {
      alert('Save failed: ' + result);
      return;
    }

    closeEditModal();
    renderGroups();
    renderMain();
  });

  document.getElementById('sc-cancel-btn').addEventListener('click', closeShortcutModal);
  document.getElementById('sc-save-btn').addEventListener('click', saveShortcut);
  document.getElementById('sc-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('sc-modal')) closeShortcutModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeEditModal(); closeShortcutModal(); }
  });

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
