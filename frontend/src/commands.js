import { go, runtime, cmdState, listeners, selectedGroup } from './state.js';
import { selectedProject } from './utils.js';
import {
  teardownListeners, setRowRunning, expandTerminal, appendLine, showExitBadge
} from './terminal.js';

export async function runCommand(cmd) {
  const proj = selectedProject();
  if (!proj) return -1;

  teardownListeners(cmd.id);

  const state = cmdState.get(cmd.id) || { lines: [], collapsed: false, exitCode: null, stopped: false, running: false };
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
    const workingDir = (selectedGroup !== 'All' && proj.groupPaths?.[selectedGroup])
      ? proj.groupPaths[selectedGroup]
      : proj.workingDir;
    await go.ExecuteCommand(cmd, workingDir, runID);
  } catch (err) {
    appendLine(cmd.id, 'ERROR: ' + err);
    setRowRunning(cmd.id, false);
    teardownListeners(cmd.id);
    resolveDone(-1);
  }

  return donePromise;
}

export function setShortcutRunning(shortcutId, running, finalState) {
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

export function setShortcutStep(shortcutId, stepIndex, state) {
  const pill = document.querySelector(
    '#shortcut-' + shortcutId + ' .sc-step[data-index="' + stepIndex + '"]'
  );
  if (pill) pill.className = 'sc-step sc-step-' + state;
}

export async function runShortcut(shortcut) {
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
