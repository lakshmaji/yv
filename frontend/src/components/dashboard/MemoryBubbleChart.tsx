import { onMount, onCleanup, createEffect, createMemo, Show } from 'solid-js';
import { Chart, type ChartConfiguration, type Plugin } from '../../lib/chartSetup';
import type { MetricsResult } from '../../types';
import { toBubbleData } from '../../lib/metricsSeries';
import { CHART_COLORS, hexToRgba, seriesColor } from '../../lib/chartTheme';
import { formatBytes } from '../../lib/utils';

interface Props {
  result: MetricsResult | null;
  title: string;
}

/**
 * Dashed y = x guide. Peak can never be below average, so every bubble sits on
 * or above this line; the vertical distance from it is how spiky that command
 * is. Without the line the reader has no baseline to judge that against.
 */
const steadyLine: Plugin<'bubble'> = {
  id: 'steadyLine',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales.x || !scales.y) return;

    const limit = Math.min(scales.x.max, scales.y.max);
    const start = Math.max(scales.x.min, scales.y.min);
    if (!(limit > start)) return;

    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexToRgba(CHART_COLORS.text, 0.22);
    ctx.moveTo(scales.x.getPixelForValue(start), scales.y.getPixelForValue(start));
    ctx.lineTo(scales.x.getPixelForValue(limit), scales.y.getPixelForValue(limit));
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = hexToRgba(CHART_COLORS.text, 0.35);
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(
      'peak = typical',
      scales.x.getPixelForValue(limit) - 6,
      scales.y.getPixelForValue(limit) + 14,
    );
    ctx.restore();
  },
};

export default function MemoryBubbleChart(props: Props) {
  let canvas!: HTMLCanvasElement;
  let chart: Chart | undefined;

  const data = createMemo(() => toBubbleData(props.result));

  function buildConfig(): Required<Pick<ChartConfiguration<'bubble'>, 'type' | 'data' | 'options'>> {
    const d = data();

    return {
      type: 'bubble',
      data: {
        datasets: d.datasets.map((ds) => {
          const color = seriesColor(ds.colorIndex);
          return {
            label: ds.label,
            data: ds.data,
            backgroundColor: hexToRgba(color, 0.4),
            borderColor: color,
            borderWidth: 1.5,
            hoverBackgroundColor: hexToRgba(color, 0.7),
            hoverBorderWidth: 2.5,
          };
        }),
      },
      options: {
        responsive: true,
        // Bubbles are discrete marks, so the one under the cursor is the right
        // target; an index-mode tooltip would list unrelated marks.
        interaction: { mode: 'nearest', intersect: true },
        plugins: {
          legend: {
            position: 'top',
            align: 'end',
            labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'circle' },
          },
          tooltip: {
            backgroundColor: 'rgba(22, 27, 34, 0.96)',
            borderColor: CHART_COLORS.border,
            borderWidth: 1,
            titleColor: CHART_COLORS.text,
            bodyColor: CHART_COLORS.muted,
            padding: { top: 9, right: 12, bottom: 9, left: 12 },
            cornerRadius: 8,
            usePointStyle: true,
            boxWidth: 8,
            boxHeight: 8,
            boxPadding: 6,
            callbacks: {
              title: (items: any[]) => items[0].dataset.label as string,
              label: (item: any) => {
                const { x, y, count } = item.raw;
                const times = count === 1 ? 'once' : `${count} times`;
                return [`typically ${formatBytes(x)}, peaking at ${formatBytes(y)}`, `seen ${times}`];
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            beginAtZero: true,
            title: { display: true, text: 'Typical memory', font: { size: 10 } },
            grid: { color: CHART_COLORS.border, drawTicks: false },
            border: { color: CHART_COLORS.border },
            ticks: {
              maxRotation: 0,
              maxTicksLimit: 8,
              callback: (value: unknown) => formatBytes(Number(value)),
            },
          },
          y: {
            type: 'linear',
            beginAtZero: true,
            title: { display: true, text: 'Peak memory', font: { size: 10 } },
            grid: { color: CHART_COLORS.border, drawTicks: false },
            border: { display: false },
            ticks: {
              maxTicksLimit: 7,
              callback: (value: unknown) => formatBytes(Number(value)),
            },
          },
        },
      },
    };
  }

  onMount(() => {
    // new Chart(canvasElement, config) — the form the Chart.js usage guide
    // documents; passing a 2d context also works but is not the documented API.
    chart = new Chart(canvas, { ...buildConfig(), plugins: [steadyLine] });
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
        <div class="heat-summary">bubble size = how often that footprint occurred</div>
      </div>
      <div class="chart-canvas-wrap">
        <canvas ref={canvas} />
        <Show when={data().datasets.length === 0}>
          <div class="chart-empty-overlay">No samples in this range yet.</div>
        </Show>
      </div>
    </div>
  );
}
