import { Show, createMemo, createEffect } from 'solid-js';
import { getCmdState, updateCmdState, setEditingCmd, resourceStats, highlightedCmd } from '../store';
import { go } from '../wails';
import { escHtml, formatBytes } from '../lib/utils';
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
    if (s.running) {
      cls += ' running';
      if (s.stopped) cls += ' stopping';
    } else if (s.exitCode !== null) {
      if (s.exitCode === 0) cls += ' done-ok';
      else if (s.stopped) cls += ' done-stopped';
      else cls += ' done-err';
    }
    // Flash the row when it was just revealed from Spotlight.
    if (highlightedCmd() === props.cmd.id) cls += ' revealed';
    return cls;
  });

  // Scroll a Spotlight-revealed row into view once it is rendered.
  createEffect(() => {
    if (highlightedCmd() !== props.cmd.id) return;
    document.getElementById(`row-${props.cmd.id}`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

  const cmdStats = createMemo(() => resourceStats().get(props.cmd.id));

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
        <Show when={hookBadge()}>
          <span class="pre-count-badge">{hookBadge()}</span>
        </Show>
        <Show when={state().running && cmdStats()}>
          {(s) => (
            <span class="cmd-resource-badge">
              {formatBytes(s().rss)} · {s().cpu.toFixed(1)}%
            </span>
          )}
        </Show>
        <Show when={state().collapsed && state().lines.length > 0}>
          <span class="line-hint">
            {(state().lines.length + state().trimmedCount).toLocaleString()} lines
          </span>
        </Show>
        <div class="cmd-actions">
          <button class="edit-btn" title="Edit command" onClick={handleEdit}>✎</button>
          <button class="dismiss-btn" onClick={handleDismiss}>✕ Dismiss</button>
          <button class="run-btn" onClick={handleRun}>▶ Run</button>
          <button class="stop-btn" onClick={handleStop}>
            <Show when={state().running && state().stopped} fallback={<>■ Stop</>}>
              <span class="stop-spin"></span>Stopping…
            </Show>
          </button>
        </div>
      </div>
      <Terminal cmd={props.cmd} />
    </div>
  );
}
