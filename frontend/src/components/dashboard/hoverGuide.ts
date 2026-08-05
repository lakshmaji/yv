import type { Chart, Plugin } from '../../lib/chartSetup';

/**
 * Draws a dashed vertical guide line through the hovered point, plus a soft
 * halo behind each active marker.
 *
 * Chart.js has no built-in crosshair. Without one, an index-mode tooltip over a
 * smooth multi-series area chart leaves the reader guessing which x position
 * the numbers belong to — the guide line answers that directly.
 *
 * It draws underneath the datasets (beforeDatasetsDraw) so the line sits behind
 * the area fills rather than cutting across them, and the halos on top.
 */
export const hoverGuide: Plugin<'line'> = {
  id: 'hoverGuide',

  beforeDatasetsDraw(chart: Chart) {
    const active = chart.getActiveElements();
    if (active.length === 0) return;

    const { ctx, chartArea } = chart;
    const x = active[0].element.x;

    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(230, 237, 243, 0.35)';
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },

  afterDatasetsDraw(chart: Chart) {
    const active = chart.getActiveElements();
    if (active.length === 0) return;

    const { ctx } = chart;
    ctx.save();
    for (const item of active) {
      const el = item.element as { x: number; y: number };
      const color = chart.data.datasets[item.datasetIndex]?.borderColor;

      ctx.beginPath();
      ctx.arc(el.x, el.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = typeof color === 'string' ? color : 'rgba(88, 166, 255, 1)';
      ctx.globalAlpha = 0.18;
      ctx.fill();
    }
    ctx.restore();
  },
};
