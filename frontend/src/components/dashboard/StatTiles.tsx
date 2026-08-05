import { createMemo, For } from 'solid-js';
import type { ActivityHeatmap, MetricsResult } from '../../types';
import { formatBytes } from '../../lib/utils';

interface Props {
  metrics: MetricsResult | null;
  activity: ActivityHeatmap | null;
  retentionDays: number;
}

interface Tile {
  label: string;
  value: string;
  hint: string;
}

export default function StatTiles(props: Props) {
  const tiles = createMemo<Tile[]>(() => {
    const series = props.metrics?.series ?? [];
    const peakRss = series.reduce((m, s) => Math.max(m, s.peakRss), 0);
    const peakCpu = series.reduce((m, s) => Math.max(m, s.peakCpu), 0);
    const days = props.activity?.days ?? [];
    const activeDays = days.filter((d) => d.total > 0).length;

    return [
      {
        label: 'Peak memory',
        value: peakRss > 0 ? formatBytes(peakRss) : '—',
        hint: 'highest single sample in range',
      },
      {
        label: 'Peak CPU',
        value: peakCpu > 0 ? `${peakCpu.toFixed(1)}%` : '—',
        hint: 'highest single sample in range',
      },
      {
        label: 'Runs',
        value: String(props.activity?.total ?? 0),
        hint: 'last 365 days',
      },
      {
        label: 'Active days',
        value: String(activeDays),
        hint: `retained for ${props.retentionDays} days`,
      },
    ];
  });

  return (
    <div class="dash-grid">
      <For each={tiles()}>
        {(t) => (
          <div class="stat-tile">
            <div class="stat-value">{t.value}</div>
            <div class="stat-label">{t.label}</div>
            <div class="stat-hint">{t.hint}</div>
          </div>
        )}
      </For>
    </div>
  );
}
