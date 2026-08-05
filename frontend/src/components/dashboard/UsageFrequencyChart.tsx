import { onMount, onCleanup, createEffect, createMemo, Show } from 'solid-js';
import { Chart, type ChartConfiguration, type ScriptableContext } from '../../lib/chartSetup';
import type { FrequencyResult } from '../../types';
import { toFrequencyChartData } from '../../lib/metricsSeries';
import {
  baseLineOptions,
  frequencyLineColor,
  frequencyStops,
  pointRadiusFor,
  progressiveAnimation,
} from '../../lib/chartTheme';
import { hoverGuide } from './hoverGuide';

interface Props {
  result: FrequencyResult | null;
  title: string;
}

/**
 * Builds the reference design's vertical ramp for one series.
 *
 * The gradient spans the whole plot area rather than the individual band, so a
 * series that only reaches a third of the height shows just the lower third of
 * its ramp — that is what makes the peaks read orange while the base stays
 * magenta.
 */
function rampFill(ctx: ScriptableContext<'line'>, index: number): CanvasGradient | undefined {
  const { chart } = ctx;
  const { ctx: canvasCtx, chartArea } = chart;
  if (!chartArea) return undefined;

  const gradient = canvasCtx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  for (const stop of frequencyStops(index, 0.92)) {
    gradient.addColorStop(stop.offset, stop.color);
  }
  return gradient;
}

export default function UsageFrequencyChart(props: Props) {
  let canvas!: HTMLCanvasElement;
  let chart: Chart | undefined;

  const data = createMemo(() => toFrequencyChartData(props.result));

  function buildConfig(): Required<Pick<ChartConfiguration<'line'>, 'type' | 'data' | 'options'>> {
    const d = data();
    // Run counts are additive across commands, so stacking shows total
    // activity as the silhouette while each band keeps its own contribution.
    const options = baseLineOptions({ stacked: true, yLabel: 'Runs' });

    options.animations = progressiveAnimation(d.timestamps.length);
    options.scales.y.ticks.precision = 0;
    options.scales.y.ticks.callback = (value: unknown) => String(Math.round(Number(value)));
    options.plugins.tooltip.callbacks = {
      label: (item: any) => {
        const n = item.parsed.y ?? 0;
        return `${item.dataset.label}: ${n} ${n === 1 ? 'run' : 'runs'}`;
      },
    };

    const radius = pointRadiusFor(d.timestamps.length);

    return {
      type: 'line',
      data: {
        labels: d.labels,
        datasets: d.datasets.map((ds, i) => {
          const line = frequencyLineColor(ds.colorIndex);
          return {
            label: ds.label,
            data: ds.data,
            borderColor: line,
            backgroundColor: (ctx: ScriptableContext<'line'>) => rampFill(ctx, ds.colorIndex),
            pointBackgroundColor: line,
            pointHoverBackgroundColor: line,
            pointRadius: radius,
            borderWidth: 2,
            fill: i === 0 ? 'origin' : '-1',
            // Counts have no gaps — an unrun bucket is a real zero.
            spanGaps: true,
          };
        }),
      },
      options,
    };
  }

  onMount(() => {
    chart = new Chart(canvas, { ...buildConfig(), plugins: [hoverGuide] });
  });

  createEffect(() => {
    const d = data();
    if (!chart) return;

    const sameShape = chart.data.datasets.length === d.datasets.length;
    const next = buildConfig();
    chart.data = next.data;
    chart.options = next.options;
    chart.update(sameShape ? 'none' : undefined);
  });

  onCleanup(() => {
    chart?.destroy();
    chart = undefined;
  });

  return (
    <div class="dash-card">
      <div class="dash-card-header">
        <div class="dash-card-title">{props.title}</div>
        <Show when={props.result}>
          {(r) => <div class="heat-summary">{r().total} runs in range</div>}
        </Show>
      </div>
      <div class="chart-canvas-wrap">
        <canvas ref={canvas} />
        <Show when={data().datasets.length === 0}>
          <div class="chart-empty-overlay">No runs in this range yet.</div>
        </Show>
      </div>
    </div>
  );
}
