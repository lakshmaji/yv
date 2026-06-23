import { cmdState, listeners } from './state.js';
import { lineHtml } from './utils.js';

export function toggleTerminal(cmdId) {
  const state = cmdState.get(cmdId);
  if (!state) return;
  state.collapsed = !state.collapsed;
  applyTerminalState(cmdId);
}

export function expandTerminal(cmdId) {
  const state = cmdState.get(cmdId);
  if (!state) return;
  state.collapsed = false;
  applyTerminalState(cmdId);
}

export function applyTerminalState(cmdId) {
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

export function clearTerminal(cmdId) {
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

export function appendLine(cmdId, line) {
  const state = cmdState.get(cmdId);
  if (state) state.lines.push(line);

  const out = document.getElementById('output-' + cmdId);
  if (!out) return;
  out.insertAdjacentHTML('beforeend', lineHtml(line));
  out.scrollTop = out.scrollHeight;

  applyTerminalState(cmdId);
}

export function showExitBadge(cmdId, result) {
  const badge = document.getElementById('exit-' + cmdId);
  if (!badge) return;
  const ok = result.exitCode === 0 && !result.error;
  badge.textContent = ok ? 'exited 0' : `exited ${result.exitCode}${result.error ? ': ' + result.error : ''}`;
  badge.className = 'exit-badge ' + (ok ? 'exit-ok' : 'exit-err');
  badge.style.display = '';
}

export function setRowRunning(cmdId, running) {
  const row = document.getElementById('row-' + cmdId);
  if (!row) return;
  if (running) {
    row.classList.add('running');
    row.classList.remove('done-ok', 'done-err', 'done-stopped', 'stopping');
  } else {
    row.classList.remove('running', 'stopping');
  }
}

export function teardownListeners(cmdId) {
  const existing = listeners.get(cmdId);
  if (existing) {
    if (typeof existing.offOutput === 'function') existing.offOutput();
    if (typeof existing.offDone === 'function') existing.offDone();
    if (typeof existing.offPostDone === 'function') existing.offPostDone();
    listeners.delete(cmdId);
  }
}
