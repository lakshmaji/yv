import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import type { ResourceStats } from '../types';
import { runtime } from '../wails';
import { formatBytes } from '../lib/utils';

export default function StatusBar() {
  const [appMem, setAppMem] = createSignal('0 B');
  const [appCpu, setAppCpu] = createSignal('0.0');
  const [cmdMem, setCmdMem] = createSignal('0 B');
  const [cmdCpu, setCmdCpu] = createSignal('0.0');
  const [cmdCount, setCmdCount] = createSignal(0);

  let unsubscribe: (() => void) | null = null;

  onMount(() => {
    unsubscribe = runtime.EventsOn('resource-stats', (stats: ResourceStats) => {
      setAppMem(formatBytes(stats.appRss || 0));
      setAppCpu((stats.appCpu || 0).toFixed(1));

      const count = stats.commands ? stats.commands.length : 0;
      setCmdCount(count);

      if (count > 0) {
        setCmdMem(formatBytes(stats.totalCmdRss || 0));
        setCmdCpu((stats.totalCmdCpu || 0).toFixed(1));
      }
    });
  });

  onCleanup(() => {
    if (unsubscribe) unsubscribe();
  });

  return (
    <div id="status-bar">
      <span class="sb-section">yv: {appMem()} · {appCpu()}%</span>
      <Show when={cmdCount() > 0}>
        <span class="sb-sep">|</span>
        <span class="sb-section">Commands: {cmdMem()} · {cmdCpu()}%</span>
        <span class="sb-sep">|</span>
        <span class="sb-section sb-running-count">{cmdCount()} running</span>
      </Show>
    </div>
  );
}
