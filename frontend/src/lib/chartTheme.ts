// Chart.js theming, kept free of any chart.js import so it stays testable in
// the node vitest environment. The chart components are the only modules that
// touch the library itself.

/**
 * Mirrors the CSS custom properties in styles.css:1-17, which remain the source
 * of truth for the app's colours. They are duplicated here rather than read via
 * getComputedStyle because Chart.js needs plain values at config time and
 * because these functions must run under a node test runner with no DOM.
 */
export const CHART_COLORS = {
  bg: '#0d1117',
  surface: '#161b22',
  border: '#30363d',
  card: '#21262d',
  text: '#e6edf3',
  muted: '#8b949e',
  accent: '#58a6ff',
} as const;

/**
 * Categorical series palette: eight fixed slots tuned for the #0d1117
 * background. Every entry clears 3:1 contrast against that background, and
 * adjacent pairs stay distinguishable under the common colour-vision
 * deficiencies.
 *
 * Colours are assigned by a series' position in a stably-sorted list, never by
 * rank, so changing the grouping or a filter does not repaint the series that
 * survived.
 */
export const SERIES_PALETTE = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const;

/**
 * Number of distinct hues available; series beyond this fold into "Other".
 * Typed as number, not the literal from the const array, so callers can pass a
 * different cap.
 */
export const MAX_SERIES: number = SERIES_PALETTE.length;

/**
 * Colour for the series at `index`. Out-of-range indices clamp rather than
 * cycle — a repeated hue would imply two series are the same thing. Callers
 * must fold their list to MAX_SERIES first (see foldSeries).
 */
export function seriesColor(index: number): string {
  if (!Number.isFinite(index) || index < 0) return SERIES_PALETTE[0];
  return SERIES_PALETTE[Math.min(Math.floor(index), MAX_SERIES - 1)];
}

/** Expands a #rgb or #rrggbb hex into an rgba() string. */
export function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export interface GradientStop {
  offset: number;
  color: string;
}

/**
 * Stops for an area fill that fades from a saturated band of the series hue at
 * the top to nothing at the baseline.
 *
 * Four stops rather than two: a linear two-stop ramp reads as a flat wash,
 * while front-loading the opacity keeps the top of the band vivid and lets the
 * bottom clear out of the way of whatever is stacked beneath it.
 *
 * Pure — the component turns these into a real CanvasGradient once the chart
 * area exists.
 */
export function gradientStops(hex: string): GradientStop[] {
  return [
    { offset: 0, color: hexToRgba(hex, 0.62) },
    { offset: 0.45, color: hexToRgba(hex, 0.3) },
    { offset: 0.8, color: hexToRgba(hex, 0.08) },
    { offset: 1, color: hexToRgba(hex, 0) },
  ];
}

/**
 * Vertical gradient ramps for the usage-frequency chart, sampled pixel-by-pixel
 * from the reference design.
 *
 * Each ramp is listed top-of-plot first. Because the gradient is built across
 * the whole chart area rather than per-series, a short band shows only the
 * lower part of its ramp — which is what produces the reference's magenta base
 * shading up to orange at the peaks.
 */
export const FREQUENCY_RAMPS: readonly (readonly string[])[] = [
  // Magenta → coral → orange (the reference's primary band).
  ['#fbb12c', '#f89554', '#f37c64', '#f1638b', '#ec559c', '#e83fb2', '#c524b2'],
  // Blue → cyan (the reference's foreground band).
  ['#04d8fd', '#07ccf6', '#0dbfef', '#12b0e8', '#1a94dd', '#1e88e5'],
  // Further ramps keep the same treatment for additional series.
  ['#7ce8a4', '#4ed88c', '#2fc47b', '#1da96c', '#158a5c'],
  ['#c9a6ff', '#a97ffb', '#8f5cf0', '#7742e0', '#6132c4'],
  ['#ffd76e', '#f7bf3f', '#e8a52a', '#d4881c', '#b96c12'],
  ['#8fd8ff', '#5cbcf5', '#3a9de3', '#2a7fc4', '#1f639e'],
  ['#ff9db1', '#f77490', '#e85174', '#cf3a5d', '#ad2a49'],
  ['#a8ecdf', '#6fd6c4', '#46bba8', '#2e9b8b', '#207c6f'],
] as const;

/** Line/legend colour for a frequency series: the midpoint of its ramp. */
export function frequencyLineColor(index: number): string {
  const ramp = FREQUENCY_RAMPS[Math.min(Math.max(index, 0), FREQUENCY_RAMPS.length - 1)];
  return ramp[Math.floor(ramp.length / 2)];
}

/** Evenly-spaced gradient stops for a frequency series' ramp. */
export function frequencyStops(index: number, alpha = 1): GradientStop[] {
  const ramp = FREQUENCY_RAMPS[Math.min(Math.max(index, 0), FREQUENCY_RAMPS.length - 1)];
  return ramp.map((color, i) => ({
    offset: ramp.length === 1 ? 0 : i / (ramp.length - 1),
    color: alpha >= 1 ? color : hexToRgba(color, alpha),
  }));
}

/**
 * Point radius for a series of `pointCount` points.
 *
 * A sparse series gets visible dots, which reads as deliberate; a dense one
 * gets none, because hundreds of touching markers turn the line into a smear.
 */
export function pointRadiusFor(pointCount: number): number {
  if (!Number.isFinite(pointCount) || pointCount <= 0) return 0;
  if (pointCount <= 30) return 3.5;
  if (pointCount <= 80) return 2;
  return 0;
}

export interface AnimationConfig {
  x: Record<string, unknown>;
  y: Record<string, unknown>;
}

/**
 * The progressive left-to-right draw-in from the Chart.js "line drawTime"
 * sample: each point animates after the one before it, so the line appears to
 * be drawn rather than to fade in.
 *
 * The `xStarted`/`yStarted` guards stop already-drawn points from replaying the
 * animation on a subsequent chart.update().
 */
export function progressiveAnimation(pointCount: number, totalMs = 1200): AnimationConfig {
  const points = Number.isFinite(pointCount) && pointCount > 0 ? Math.floor(pointCount) : 1;
  // Clamp so a very dense series does not animate at an imperceptible 0.1ms per
  // point, and a very sparse one does not crawl.
  const delay = Math.max(2, Math.min(60, totalMs / points));

  const axis = (started: 'xStarted' | 'yStarted') => ({
    type: 'number',
    easing: 'linear',
    duration: delay,
    from: NaN,
    delay(ctx: any) {
      if (ctx.type !== 'data' || ctx[started]) return 0;
      ctx[started] = true;
      return ctx.index * delay;
    },
  });

  return { x: axis('xStarted'), y: axis('yStarted') };
}

export interface LineOptionsInput {
  /** Stack the areas. Correct for additive series such as run counts. */
  stacked: boolean;
  /** Y-axis title. */
  yLabel: string;
}

/**
 * The dark-theme Chart.js options shared by every metric chart. Returned as a
 * plain object so a test can assert the colours have not drifted from
 * CHART_COLORS.
 */
export function baseLineOptions(input: LineOptionsInput): Record<string, any> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    elements: {
      line: { tension: 0.4, borderWidth: 2.5, borderJoinStyle: 'round', capBezierPoints: true },
      point: {
        radius: 0,
        hoverRadius: 6,
        hitRadius: 14,
        borderWidth: 0,
        hoverBorderWidth: 2.5,
        hoverBorderColor: CHART_COLORS.bg,
      },
    },
    plugins: {
      legend: {
        display: true,
        position: 'top',
        align: 'end',
        labels: {
          color: CHART_COLORS.muted,
          boxWidth: 10,
          boxHeight: 10,
          usePointStyle: true,
          pointStyle: 'circle',
          font: { size: 11 },
        },
      },
      tooltip: {
        backgroundColor: 'rgba(22, 27, 34, 0.96)',
        borderColor: CHART_COLORS.border,
        borderWidth: 1,
        titleColor: CHART_COLORS.muted,
        titleFont: { size: 10, weight: 'normal' },
        bodyColor: CHART_COLORS.text,
        bodyFont: { size: 12 },
        bodySpacing: 5,
        padding: { top: 9, right: 12, bottom: 9, left: 12 },
        cornerRadius: 8,
        caretSize: 6,
        displayColors: true,
        usePointStyle: true,
        boxWidth: 8,
        boxHeight: 8,
        boxPadding: 6,
      },
    },
    scales: {
      x: {
        stacked: input.stacked,
        grid: { color: CHART_COLORS.border, drawTicks: false },
        border: { color: CHART_COLORS.border },
        ticks: { color: CHART_COLORS.muted, maxRotation: 0, autoSkipPadding: 24, font: { size: 10 } },
      },
      y: {
        stacked: input.stacked,
        beginAtZero: true,
        title: { display: true, text: input.yLabel, color: CHART_COLORS.muted, font: { size: 10 } },
        grid: { color: CHART_COLORS.border, drawTicks: false },
        border: { display: false },
        ticks: { color: CHART_COLORS.muted, font: { size: 10 } },
      },
    },
  };
}
