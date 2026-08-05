// Turning a MetricsResult into Chart.js-shaped data. Pure and chart.js-free so
// it runs under the node test environment.

import type {
  FrequencyResult,
  MetricKind,
  MetricsPoint,
  MetricsResult,
  MetricsSeries,
} from '../types';
import { MAX_SERIES } from './chartTheme';

/** Label used for the summed tail when there are more series than hues. */
export const OTHER_LABEL = 'Other';
const OTHER_KEY = '__other__';

/** Reads the value a given metric cares about out of a point. */
export function pointValue(pt: MetricsPoint, metric: MetricKind): number {
  return metric === 'cpu' ? pt.cpuAvg : pt.rssAvg;
}

function seriesPeak(s: MetricsSeries, metric: MetricKind): number {
  return metric === 'cpu' ? s.peakCpu : s.peakRss;
}

/**
 * Caps the series list at the number of available hues, summing everything past
 * the cap into a single "Other" series.
 *
 * The kept series stay in their incoming order so their colours do not shift
 * when a heavier series appears or disappears; only the selection is by peak.
 */
export function foldSeries(
  series: MetricsSeries[],
  metric: MetricKind = 'memory',
  max: number = MAX_SERIES,
): MetricsSeries[] {
  if (max <= 0) return [];
  if (series.length <= max) return series;

  // Rank a copy; ties break on key so repeated polls agree.
  const ranked = [...series].sort((a, b) => {
    const diff = seriesPeak(b, metric) - seriesPeak(a, metric);
    return diff !== 0 ? diff : a.key.localeCompare(b.key);
  });

  const keepKeys = new Set(ranked.slice(0, max - 1).map((s) => s.key));
  const kept = series.filter((s) => keepKeys.has(s.key));
  const tail = series.filter((s) => !keepKeys.has(s.key));

  return [...kept, sumSeries(tail, OTHER_KEY, OTHER_LABEL)];
}

/** Element-wise sum of several series onto their union of timestamps. */
function sumSeries(series: MetricsSeries[], key: string, label: string): MetricsSeries {
  const byT = new Map<number, MetricsPoint>();

  for (const s of series) {
    for (const pt of s.points) {
      const acc = byT.get(pt.t);
      if (!acc) {
        byT.set(pt.t, { ...pt });
        continue;
      }
      acc.n = Math.max(acc.n, pt.n);
      acc.rssAvg += pt.rssAvg;
      acc.cpuAvg += pt.cpuAvg;
      acc.rssPeak = Math.max(acc.rssPeak, pt.rssPeak);
      acc.cpuPeak = Math.max(acc.cpuPeak, pt.cpuPeak);
    }
  }

  const points = [...byT.values()].sort((a, b) => a.t - b.t);
  return {
    key,
    label,
    points,
    peakRss: points.reduce((m, p) => Math.max(m, p.rssPeak), 0),
    peakCpu: points.reduce((m, p) => Math.max(m, p.cpuPeak), 0),
  };
}

/**
 * Formats a bucket timestamp for the category axis. The format widens with the
 * bucket size, which is what lets the charts use a CategoryScale and avoid
 * pulling in a Chart.js date adapter.
 */
export function bucketLabel(unixSec: number, bucketSeconds: number): string {
  const d = new Date(unixSec * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const month = d.toLocaleString('en-US', { month: 'short' });
  const day = d.getDate();

  if (bucketSeconds <= 3600) return `${hh}:${mm}`;
  if (bucketSeconds < 86400) return `${month} ${day} ${hh}:${mm}`;
  return `${month} ${day}`;
}

export interface ChartDataset {
  key: string;
  label: string;
  data: (number | null)[];
  colorIndex: number;
}

export interface ChartData {
  labels: string[];
  timestamps: number[];
  datasets: ChartDataset[];
}

/**
 * Aligns every series onto the union of bucket timestamps, filling absent
 * buckets with null so the chart shows a gap rather than a fabricated zero
 * (paired with spanGaps: false).
 */
export function toChartData(result: MetricsResult | null, metric: MetricKind): ChartData {
  const empty: ChartData = { labels: [], timestamps: [], datasets: [] };
  if (!result || result.series.length === 0) return empty;

  const folded = foldSeries(result.series, metric);

  const tsSet = new Set<number>();
  for (const s of folded) {
    for (const pt of s.points) tsSet.add(pt.t);
  }
  const timestamps = [...tsSet].sort((a, b) => a - b);
  if (timestamps.length === 0) return empty;

  const bucket = result.resolution > 0 ? result.resolution : 60;

  return {
    labels: timestamps.map((t) => bucketLabel(t, bucket)),
    timestamps,
    datasets: folded.map((s, i) => {
      const byT = new Map(s.points.map((p) => [p.t, pointValue(p, metric)]));
      return {
        key: s.key,
        label: s.label,
        colorIndex: i,
        data: timestamps.map((t) => (byT.has(t) ? byT.get(t)! : null)),
      };
    }),
  };
}

export interface BubblePoint {
  x: number; // typical (average) RSS for this bin
  y: number; // peak RSS for this bin
  r: number; // radius, area-proportional to how often the bin occurred
  count: number; // the frequency the radius encodes, for the tooltip
}

export interface BubbleDataset {
  key: string;
  label: string;
  colorIndex: number;
  data: BubblePoint[];
}

export interface BubbleData {
  datasets: BubbleDataset[];
  maxCount: number;
  /** Largest value on either axis, used to place the avg == peak diagonal. */
  axisMax: number;
}

/**
 * Bin width for the memory profile, chosen so the largest value lands in the
 * last of roughly `bins` slots. Binning is what lets repeated behaviour pile
 * up into one large bubble instead of scattering into identical small ones.
 */
export function profileBinSize(maxValue: number, bins = 26): number {
  if (!Number.isFinite(maxValue) || maxValue <= 0 || bins <= 0) return 1;
  return maxValue / bins;
}

/**
 * Radius for a bubble encoding `value` against `maxValue`.
 *
 * Scaled by square root, so the bubble's *area* — not its diameter — is
 * proportional to the value. Linear radius scaling would exaggerate large
 * values roughly quadratically, which is the classic bubble-chart lie.
 */
export function bubbleRadius(value: number, maxValue: number, minR = 3, maxR = 20): number {
  if (!Number.isFinite(value) || value <= 0 || maxValue <= 0) return minR;
  const ratio = Math.min(value / maxValue, 1);
  return minR + (maxR - minR) * Math.sqrt(ratio);
}

/**
 * Chart data for the memory profile: typical memory on x, peak memory on y,
 * and how often that combination occurred as the bubble's area.
 *
 * This mirrors the bubble chart in the Chart.js usage guide, which plots
 * artwork width against height and sizes each bubble by frequency. Two
 * measured dimensions against each other says more here than memory against
 * time did: the y = x diagonal is "steady", and the further a bubble sits
 * above it the spikier that command is. Repeated behaviour piles into one big
 * bubble, so a command's habitual footprint is immediately visible — which
 * seven overlapping time series could never show.
 */
export function toBubbleData(result: MetricsResult | null, max = MAX_SERIES): BubbleData {
  const empty: BubbleData = { datasets: [], maxCount: 0, axisMax: 0 };
  if (!result || result.series.length === 0) return empty;

  const folded = foldSeries(result.series, 'memory', max);

  let axisMax = 0;
  for (const s of folded) {
    for (const pt of s.points) {
      if (pt.rssPeak > axisMax) axisMax = pt.rssPeak;
      if (pt.rssAvg > axisMax) axisMax = pt.rssAvg;
    }
  }
  if (axisMax <= 0) return empty;

  const bin = profileBinSize(axisMax);
  const snap = (v: number) => Math.round(v / bin) * bin;

  // First pass: bin each series and count occurrences.
  const binned = folded.map((s) => {
    const cells = new Map<string, { x: number; y: number; count: number }>();
    for (const pt of s.points) {
      const x = snap(pt.rssAvg);
      const y = snap(pt.rssPeak);
      const key = `${x}|${y}`;
      const cell = cells.get(key);
      if (cell) {
        cell.count++;
      } else {
        cells.set(key, { x, y, count: 1 });
      }
    }
    return { series: s, cells: [...cells.values()] };
  });

  // Radii are scaled against the global maximum so bubble sizes are comparable
  // across series, not just within one.
  let maxCount = 0;
  for (const b of binned) {
    for (const cell of b.cells) {
      if (cell.count > maxCount) maxCount = cell.count;
    }
  }

  return {
    maxCount,
    axisMax,
    datasets: binned.map((b, i) => ({
      key: b.series.key,
      label: b.series.label,
      colorIndex: i,
      data: b.cells
        .sort((p, q) => q.count - p.count) // draw the rare, small bubbles last
        .map((cell) => ({
          x: cell.x,
          y: cell.y,
          r: bubbleRadius(cell.count, maxCount, 4, 24),
          count: cell.count,
        })),
    })),
  };
}

/**
 * Chart data for the usage-frequency chart.
 *
 * Go already emits every series on a shared bucket axis with explicit zeros,
 * so unlike toChartData there is nothing to align or null-pad — an unrun
 * bucket is a real zero, not missing data.
 *
 * Series beyond the available gradient ramps are summed into "Other" so the
 * chart never repeats a ramp.
 */
export function toFrequencyChartData(result: FrequencyResult | null, max = MAX_SERIES): ChartData {
  const empty: ChartData = { labels: [], timestamps: [], datasets: [] };
  if (!result || result.series.length === 0) return empty;

  let series = result.series;
  if (series.length > max) {
    const ranked = [...series].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
    const keep = new Set(ranked.slice(0, max - 1).map((s) => s.key));
    const kept = series.filter((s) => keep.has(s.key));
    const tail = series.filter((s) => !keep.has(s.key));

    const merged = tail[0].points.map((p, i) => ({
      t: p.t,
      count: tail.reduce((sum, s) => sum + (s.points[i]?.count ?? 0), 0),
    }));
    series = [
      ...kept,
      {
        key: '__other__',
        label: OTHER_LABEL,
        points: merged,
        total: tail.reduce((sum, s) => sum + s.total, 0),
      },
    ];
  }

  const timestamps = series[0].points.map((p) => p.t);
  if (timestamps.length === 0) return empty;

  const bucket = result.resolution > 0 ? result.resolution : 3600;

  return {
    labels: timestamps.map((t) => bucketLabel(t, bucket)),
    timestamps,
    datasets: series.map((s, i) => ({
      key: s.key,
      label: s.label,
      colorIndex: i,
      data: s.points.map((p) => p.count),
    })),
  };
}
