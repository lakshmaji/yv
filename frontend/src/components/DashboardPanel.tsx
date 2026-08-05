import { createEffect, createMemo, createSignal, For, onMount, Show } from 'solid-js';
import {
  appSettings,
  activityHeatmap,
  dashError,
  dashGroupBy,
  dashLoading,
  dashRangeDays,
  loadDashboard,
  frequencyResult,
  metricsResult,
  projects,
  setDashGroupBy,
  setDashRangeDays,
} from '../store';
import { go } from '../wails';
import { isPanelVisible } from '../lib/dashboardPanels';
import type { MetricGroupBy } from '../types';
import StatTiles from './dashboard/StatTiles';
import MemoryBubbleChart from './dashboard/MemoryBubbleChart';
import UsageFrequencyChart from './dashboard/UsageFrequencyChart';
import ActivityHeatmapView from './dashboard/ActivityHeatmap';
import DashboardEmptyState from './dashboard/DashboardEmptyState';

const GROUP_BY_OPTIONS: { id: MetricGroupBy; label: string }[] = [
  { id: 'command', label: 'Command' },
  { id: 'project', label: 'Project' },
  { id: 'group', label: 'Group' },
];

const RANGE_OPTIONS: { days: number; label: string }[] = [
  { days: 1, label: '24h' },
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 365, label: '1y' },
];

export default function DashboardPanel() {
  const enabled = () => appSettings().metricsEnabled;

  // Whether this build can seed sample data. Asked of Go rather than read from
  // import.meta.env.DEV: Vite runs a production build under `make build-dev`
  // too, so only the Go build tag knows the answer.
  const [canSeed, setCanSeed] = createSignal(false);
  onMount(async () => {
    try {
      setCanSeed(await go.SampleDataAvailable());
    } catch {
      setCanSeed(false);
    }
  });

  // Go groups by project ID, which is a UUID. Swap in the project name so the
  // legend is readable; an ID with no matching project (a deleted project, or
  // seeded sample data) falls back to the raw key.
  const resolved = createMemo(() => {
    const result = metricsResult();
    if (!result || result.groupBy !== 'project') return result;

    const names = new Map(projects.map((p) => [p.id, p.name]));
    return {
      ...result,
      series: result.series.map((s) => ({ ...s, label: names.get(s.key) ?? s.label })),
    };
  });

  const resolvedFrequency = createMemo(() => {
    const result = frequencyResult();
    if (!result || result.groupBy !== 'project') return result;

    const names = new Map(projects.map((p) => [p.id, p.name]));
    return {
      ...result,
      series: result.series.map((s) => ({ ...s, label: names.get(s.key) ?? s.label })),
    };
  });

  // Reload whenever a control changes or metrics get switched on. Deliberately
  // not wired to the 3s resource-stats event: a live refresh would replay the
  // chart's draw-in animation continuously.
  createEffect(() => {
    if (!enabled()) return;
    const groupBy = dashGroupBy();
    const rangeDays = dashRangeDays();
    void loadDashboard({ metrics: go.GetMetrics, frequency: go.GetUsageFrequency, activity: go.GetActivityHeatmap }, { groupBy, rangeDays });
  });

  // Development only — hidden unless Go reports the seeder is compiled in.
  // the Go binding behind it lives behind the `yvdev` build tag.
  async function loadSample() {
    try {
      const msg = await go.ImportSampleMetrics();
      if (msg) refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  function refresh() {
    void loadDashboard(
      { metrics: go.GetMetrics, frequency: go.GetUsageFrequency, activity: go.GetActivityHeatmap },
      { groupBy: dashGroupBy(), rangeDays: dashRangeDays() },
    );
  }

  return (
    <main id="main" class="dashboard">
      <div id="dashboard-header">
        <div class="dash-heading">
          <span class="dash-title">Dashboard</span>
          <span class="dash-subtitle">Resource usage and activity across every project</span>
        </div>
      </div>

      <Show when={enabled()} fallback={<DashboardEmptyState />}>
        <div class="dash-toolbar">
          <div class="dash-seg" role="group" aria-label="Group by">
            <For each={GROUP_BY_OPTIONS}>
              {(opt) => (
                <button
                  type="button"
                  classList={{ active: dashGroupBy() === opt.id }}
                  onClick={() => setDashGroupBy(opt.id)}
                >
                  {opt.label}
                </button>
              )}
            </For>
          </div>

          <div class="dash-seg" role="group" aria-label="Time range">
            <For each={RANGE_OPTIONS}>
              {(opt) => (
                <button
                  type="button"
                  classList={{ active: dashRangeDays() === opt.days }}
                  onClick={() => setDashRangeDays(opt.days)}
                >
                  {opt.label}
                </button>
              )}
            </For>
          </div>

          <Show when={canSeed()}>
            <button type="button" class="dash-sample" onClick={loadSample} title="Development only">
              ⇣ Load sample data
            </button>
          </Show>

          <button type="button" class="dash-refresh" onClick={refresh} disabled={dashLoading()}>
            {dashLoading() ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>

        <Show when={dashError()}>
          <div class="env-modal-error">{dashError()}</div>
        </Show>

        <Show when={isPanelVisible(appSettings(), 'stats')}>
          <StatTiles
            metrics={resolved()}
            activity={activityHeatmap()}
            retentionDays={appSettings().retentionDays}
          />
        </Show>

        <Show when={isPanelVisible(appSettings(), 'memory')}>
          <MemoryBubbleChart result={resolved()} title="Memory over time" />
        </Show>

        <Show when={isPanelVisible(appSettings(), 'frequency')}>
          <UsageFrequencyChart result={resolvedFrequency()} title="Command usage frequency" />
        </Show>

        <Show when={isPanelVisible(appSettings(), 'activity')}>
          <ActivityHeatmapView data={activityHeatmap()} />
        </Show>

        <Show when={(metricsResult()?.seriesOmitted ?? 0) > 0}>
          <div class="dash-note">
            {metricsResult()!.seriesOmitted} lighter series were left out of the charts.
          </div>
        </Show>
      </Show>
    </main>
  );
}
