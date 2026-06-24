import { For, Show, createEffect, onCleanup } from 'solid-js';
import { getCmdState, updateCmdState } from '../store';
import { go } from '../wails';
import { escHtml, lineClass } from '../lib/utils';
import type { CommandConfig } from '../types';

interface TerminalProps {
  cmd: CommandConfig;
}

export default function Terminal(props: TerminalProps) {
  let outputRef: HTMLDivElement | undefined;

  createEffect(() => {
    const s = getCmdState(props.cmd.id);
    if (outputRef && !s.collapsed && s.lines.length > 0) {
      outputRef.scrollTop = outputRef.scrollHeight;
    }
  });

  function handleClear() {
    updateCmdState(props.cmd.id, {
      lines: [],
      exitCode: null,
      collapsed: true,
      stopped: false,
      trimmedCount: 0,
    });
  }

  function handleStdinKeydown(e: KeyboardEvent) {
    const input = e.target as HTMLInputElement;
    if (e.key === 'Enter') {
      const text = input.value;
      input.value = '';
      go.SendInput(props.cmd.id, text + '\n');
    } else if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      go.SendInput(props.cmd.id, '\x03');
    } else if (e.ctrlKey && e.key === 'd') {
      e.preventDefault();
      go.SendInput(props.cmd.id, '\x04');
    }
  }

  const state = () => getCmdState(props.cmd.id);

  return (
    <div class="cmd-terminal">
      <div class="terminal-toolbar">
        <Show when={state().exitCode !== null}>
          <span
            class={`exit-badge ${state().exitCode === 0 ? 'exit-ok' : 'exit-err'}`}
          >
            exited {state().exitCode}
          </span>
        </Show>
        <button class="clear-btn" onClick={handleClear}>Clear</button>
      </div>
      <div class="terminal-output" ref={outputRef}>
        <Show when={state().trimmedCount > 0}>
          <div class="trim-notice">
            [{state().trimmedCount.toLocaleString()} earlier lines trimmed]
          </div>
        </Show>
        <For each={state().lines}>
          {(line) => <div class={lineClass(line)}>{line}</div>}
        </For>
      </div>
      <Show when={props.cmd.interactive}>
        <div class="terminal-stdin">
          <span class="terminal-stdin-label">stdin →</span>
          <input
            type="text"
            class="terminal-input-field"
            placeholder="Enter to send · Ctrl+C to interrupt · Ctrl+D for EOF"
            onKeyDown={handleStdinKeydown}
          />
        </div>
      </Show>
    </div>
  );
}
