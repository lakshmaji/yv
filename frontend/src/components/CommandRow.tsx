import { Show, createMemo } from 'solid-js';
import { getCmdState, updateCmdState, setEditingCmd } from '../store';
import { go } from '../wails';
import { escHtml } from '../lib/utils';
import { runCommand } from '../lib/commands';
import Terminal from './Terminal';
import type { CommandConfig } from '../types';

interface CommandRowProps {
  cmd: CommandConfig;
}

export default function CommandRow(props: CommandRowProps) {
  const state = () => getCmdState(props.cmd.id);

  const rowClass = createMemo(() => {
    const s = state();
    let cls = 'cmd-row';
    if (!s.collapsed && s.lines.length) cls += ' expanded';
    if (s.running) cls += ' running';
    else if (s.exitCode !== null) {
      if (s.exitCode === 0) cls += ' done-ok';
      else if (s.stopped) cls += ' done-stopped';
      else cls += ' done-err';
    }
    return cls;
  });

  function handleToggle(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.cmd-actions')) return;
    const s = state();
    updateCmdState(props.cmd.id, { collapsed: !s.collapsed });
  }

  function handleRun(e: MouseEvent) {
    e.stopPropagation();
    runCommand(props.cmd);
  }

  async function handleStop(e: MouseEvent) {
    e.stopPropagation();
    updateCmdState(props.cmd.id, s => ({ ...s, stopped: true }));
    if (props.cmd.interactive) go.SendInput(props.cmd.id, '\x03');
    const result = await go.StopCommand(props.cmd.id);
    if (result === 'not running') {
      updateCmdState(props.cmd.id, s => ({
        ...s,
        running: false,
        collapsed: true,
        exitCode: -1,
      }));
    }
  }

  function handleDismiss(e: MouseEvent) {
    e.stopPropagation();
    updateCmdState(props.cmd.id, { collapsed: true });
  }

  function handleEdit(e: MouseEvent) {
    e.stopPropagation();
    setEditingCmd(props.cmd.id);
  }

  const preCount = () => props.cmd.preCommands?.length || 0;
  const postCount = () => props.cmd.postCommands?.length || 0;

  const hookBadge = createMemo(() => {
    const pre = preCount();
    const post = postCount();
    if (pre && post) return `${pre} pre · ${post} post`;
    if (pre) return `${pre} pre hook${pre > 1 ? 's' : ''}`;
    if (post) return `${post} post hook${post > 1 ? 's' : ''}`;
    return '';
  });

  return (
    <div class={rowClass()} id={`row-${props.cmd.id}`}>
      <div class="cmd-header" onClick={handleToggle}>
        <span class="chevron">▶</span>
        <span class="cmd-spinner"><span class="loader"></span></span>
        <span class="cmd-label">{props.cmd.label}</span>
        <span class="cmd-snippet" title={props.cmd.command}>{props.cmd.command}</span>
        <Show when={props.cmd.workingDir}>
          <span class="cmd-dir" title={props.cmd.workingDir}>{props.cmd.workingDir}</span>
        </Show>
        <Show when={hookBadge()}>
          <span class="pre-count-badge">{hookBadge()}</span>
        </Show>
        <span class="cmd-resource-badge" id={`res-${props.cmd.id}`} style={{ display: 'none' }}></span>
        <Show when={state().collapsed && state().lines.length > 0}>
          <span class="line-hint">
            {(state().lines.length + state().trimmedCount).toLocaleString()} lines
          </span>
        </Show>
        <div class="cmd-actions">
          <button class="edit-btn" title="Edit command" onClick={handleEdit}>✎</button>
          <button class="dismiss-btn" onClick={handleDismiss}>✕ Dismiss</button>
          <button class="run-btn" onClick={handleRun}>▶ Run</button>
          <button class="stop-btn" onClick={handleStop}>■ Stop</button>
        </div>
      </div>
      <Terminal cmd={props.cmd} />
    </div>
  );
}
