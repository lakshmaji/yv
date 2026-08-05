import { go, runtime } from '../wails';
import {
  selectedGroup, selectedProject,
  getCmdState, updateCmdState, listeners,
  updateShortcutState,
  projects, setProjects,
} from '../store';
import type { CommandConfig, Shortcut, CommandResult } from '../types';

const MAX_LINES = 5000;
const TRIM_BATCH = 500;

export async function runCommand(cmd: CommandConfig): Promise<number> {
  const proj = selectedProject();
  if (!proj) return -1;

  const existing = getCmdState(cmd.id);
  if (existing.running) {
    await go.StopCommand(cmd.id);
  }

  teardownListeners(cmd.id);

  updateCmdState(cmd.id, {
    lines: [],
    collapsed: false,
    exitCode: null,
    stopped: false,
    running: true,
    trimmedCount: 0,
  });

  const runID = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const hasPostHooks = !!(cmd.postCommands && cmd.postCommands.length);

  const offOutput = runtime.EventsOn('output:' + cmd.id + ':' + runID, (line: string) => {
    updateCmdState(cmd.id, s => {
      const lines = [...s.lines, line];
      let trimmedCount = s.trimmedCount;
      if (lines.length > MAX_LINES + TRIM_BATCH) {
        const excess = lines.length - MAX_LINES;
        lines.splice(0, excess);
        trimmedCount += excess;
      }
      return { ...s, lines, trimmedCount };
    });
  });

  let resolveDone: (code: number) => void;
  const donePromise = new Promise<number>(resolve => { resolveDone = resolve; });
  let promiseResolved = false;
  let mainExited = false;

  function applyFinalResult(result: CommandResult) {
    teardownListeners(cmd.id);
    const s = getCmdState(cmd.id);
    const wasStopped = s.stopped;
    updateCmdState(cmd.id, prev => ({
      ...prev,
      running: false,
      exitCode: result.exitCode,
      collapsed: wasStopped ? true : prev.collapsed,
    }));
    if (!promiseResolved) { promiseResolved = true; resolveDone!(result.exitCode); }
  }

  const offDone = runtime.EventsOn('done:' + cmd.id + ':' + runID, (result: CommandResult) => {
    mainExited = true;
    applyFinalResult(result);
  });

  let offPostDone: (() => void) | null = null;
  if (hasPostHooks) {
    offPostDone = runtime.EventsOn('post-done:' + cmd.id + ':' + runID, (result: CommandResult) => {
      if (mainExited) {
        applyFinalResult(result);
      } else {
        if (!promiseResolved) { promiseResolved = true; resolveDone!(result.exitCode); }
      }
    });
  }

  listeners.set(cmd.id, { offOutput, offDone, offPostDone });

  try {
    const group = selectedGroup();
    const effectiveGroup = group !== 'All' ? group : cmd.group;
    let workingDir = (effectiveGroup && proj.groupPaths?.[effectiveGroup])
      ? proj.groupPaths[effectiveGroup]
      : proj.workingDir;

    const pathOk = await go.CheckPath(workingDir);
    if (!pathOk) {
      const picked = await go.PickFolder();
      if (!picked) {
        teardownListeners(cmd.id);
        updateCmdState(cmd.id, { running: false, exitCode: -1 });
        resolveDone!(-1);
        return donePromise;
      }
      workingDir = picked;
      // Persist the chosen path so future runs use it automatically.
      const all = JSON.parse(JSON.stringify([...projects]));
      const idx = all.findIndex((p: any) => p.id === proj.id);
      if (idx !== -1) {
        if (effectiveGroup) {
          all[idx].groupPaths = { ...(all[idx].groupPaths || {}), [effectiveGroup]: picked };
        } else {
          all[idx].workingDir = picked;
        }
        setProjects(all);
        go.SaveProjects(all);
      }
    }

    // proj.id lets Go apply the project's active environment variables.
    await go.ExecuteCommand(cmd as any, workingDir, runID, proj.id);
  } catch (err) {
    updateCmdState(cmd.id, s => ({
      ...s,
      running: false,
      lines: [...s.lines, 'ERROR: ' + err],
    }));
    teardownListeners(cmd.id);
    resolveDone!(-1);
  }

  return donePromise;
}

// stopAllCommands kills every running command process across all projects.
// Running rows are flagged `stopped` up front so they settle into the grey
// done-stopped state; the per-command `done` events (fired as each process
// dies) then flip `running` off. Returns the number of commands it stopped.
export async function stopAllCommands(): Promise<number> {
  let count = 0;
  for (const proj of projects) {
    for (const cmd of proj.commands) {
      if (getCmdState(cmd.id).running) {
        count++;
        updateCmdState(cmd.id, s => ({ ...s, stopped: true }));
      }
    }
  }
  if (count > 0) await go.StopAllCommands();
  return count;
}

export async function runShortcut(shortcut: Shortcut): Promise<void> {
  const proj = selectedProject();
  if (!proj) return;

  updateShortcutState(shortcut.id, { running: true, finalState: null, steps: {} });

  for (let i = 0; i < shortcut.commandIds.length; i++) {
    const cmd = proj.commands.find(c => c.id === shortcut.commandIds[i]);
    if (!cmd) continue;

    updateShortcutState(shortcut.id, s => ({
      ...s,
      steps: { ...s.steps, [i]: 'running' as const },
    }));

    const exitCode = await runCommand(cmd);

    if (exitCode !== 0) {
      updateShortcutState(shortcut.id, s => {
        const steps = { ...s.steps, [i]: 'failed' as const };
        for (let j = i + 1; j < shortcut.commandIds.length; j++) {
          steps[j] = 'skipped' as const;
        }
        return { ...s, running: false, finalState: 'failed' as const, steps };
      });
      return;
    }

    updateShortcutState(shortcut.id, s => ({
      ...s,
      steps: { ...s.steps, [i]: 'ok' as const },
    }));
  }

  updateShortcutState(shortcut.id, s => ({ ...s, running: false, finalState: 'ok' as const }));
}

function teardownListeners(cmdId: string) {
  const existing = listeners.get(cmdId);
  if (existing) {
    existing.offOutput();
    existing.offDone();
    existing.offPostDone?.();
    listeners.delete(cmdId);
  }
}
