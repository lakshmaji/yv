import { describe, it, expect } from 'vitest';
import {
  foldSeries,
  bucketLabel,
  toChartData,
  toFrequencyChartData,
  toBubbleData,
  bubbleRadius,
  profileBinSize,
  pointValue,
  OTHER_LABEL,
} from './metricsSeries';
import type { FrequencyResult, MetricsPoint, MetricsResult, MetricsSeries } from '../types';

function pt(t: number, rss: number, cpu = 0): MetricsPoint {
  return { t, n: 20, rssAvg: rss, rssPeak: rss * 2, cpuAvg: cpu, cpuPeak: cpu * 2 };
}

function series(key: string, points: MetricsPoint[]): MetricsSeries {
  return {
    key,
    label: key,
    points,
    peakRss: points.reduce((m, p) => Math.max(m, p.rssPeak), 0),
    peakCpu: points.reduce((m, p) => Math.max(m, p.cpuPeak), 0),
  };
}

describe('pointValue', () => {
  const p = pt(0, 500, 12);
  it('reads memory', () => expect(pointValue(p, 'memory')).toBe(500));
  it('reads cpu', () => expect(pointValue(p, 'cpu')).toBe(12));
});

describe('foldSeries', () => {
  it('passes through a list under the cap, unchanged and in order', () => {
    const input = [series('a', [pt(0, 1)]), series('b', [pt(0, 2)])];
    const got = foldSeries(input, 'memory', 8);
    expect(got.map((s) => s.key)).toEqual(['a', 'b']);
  });

  it('passes through a list exactly at the cap', () => {
    const input = Array.from({ length: 8 }, (_, i) => series(`s${i}`, [pt(0, i + 1)]));
    expect(foldSeries(input, 'memory', 8)).toHaveLength(8);
  });

  it('folds the tail into a single Other series', () => {
    const input = Array.from({ length: 12 }, (_, i) => series(`s${i}`, [pt(0, i + 1)]));
    const got = foldSeries(input, 'memory', 8);
    expect(got).toHaveLength(8);
    expect(got[got.length - 1].label).toBe(OTHER_LABEL);
  });

  it('keeps the heaviest series and sums the rest', () => {
    const input = [
      series('big', [pt(0, 1000)]),
      series('a', [pt(0, 1)]),
      series('b', [pt(0, 2)]),
      series('c', [pt(0, 3)]),
    ];
    const got = foldSeries(input, 'memory', 2);
    expect(got[0].key).toBe('big');
    expect(got[1].label).toBe(OTHER_LABEL);
    expect(got[1].points[0].rssAvg).toBe(6); // 1 + 2 + 3
  });

  it('preserves incoming order for the kept series, so colours do not shift', () => {
    const input = [
      series('a', [pt(0, 10)]),
      series('b', [pt(0, 1000)]),
      series('c', [pt(0, 100)]),
      series('d', [pt(0, 1)]),
    ];
    const got = foldSeries(input, 'memory', 3);
    // b and c are the heaviest, but they stay in their original relative order.
    expect(got.slice(0, 2).map((s) => s.key)).toEqual(['b', 'c']);
  });

  it('sums the tail across disjoint timestamps', () => {
    const input = [
      series('keep', [pt(0, 1000)]),
      series('x', [pt(0, 10)]),
      series('y', [pt(60, 20)]),
    ];
    const other = foldSeries(input, 'memory', 2)[1];
    expect(other.points.map((p) => [p.t, p.rssAvg])).toEqual([
      [0, 10],
      [60, 20],
    ]);
  });

  it('ranks by the requested metric', () => {
    const heavyMem = { ...series('mem', [pt(0, 1000, 1)]) };
    const heavyCpu = { ...series('cpu', [pt(0, 1, 90)]) };
    const got = foldSeries([heavyMem, heavyCpu], 'cpu', 2);
    expect(got).toHaveLength(2); // under the cap, nothing folded
    const folded = foldSeries([heavyMem, heavyCpu, series('z', [pt(0, 2, 2)])], 'cpu', 2);
    expect(folded[0].key).toBe('cpu');
  });

  it('handles an empty list', () => {
    expect(foldSeries([], 'memory', 8)).toEqual([]);
  });

  it('returns nothing for a zero cap', () => {
    expect(foldSeries([series('a', [pt(0, 1)])], 'memory', 0)).toEqual([]);
  });
});

describe('bucketLabel', () => {
  // 2024-03-03 14:05 local
  const t = Math.floor(new Date(2024, 2, 3, 14, 5, 0).getTime() / 1000);

  const cases: [string, number, string][] = [
    ['one-minute buckets show time only', 60, '14:05'],
    ['one-hour buckets show time only', 3600, '14:05'],
    ['six-hour buckets show date and time', 21600, 'Mar 3 14:05'],
    ['one-day buckets show the date', 86400, 'Mar 3'],
  ];

  it.each(cases)('%s', (_name, bucket, expected) => {
    expect(bucketLabel(t, bucket)).toBe(expected);
  });

  it('zero-pads midnight', () => {
    const midnight = Math.floor(new Date(2024, 2, 3, 0, 5, 0).getTime() / 1000);
    expect(bucketLabel(midnight, 60)).toBe('00:05');
  });

  it('handles a year boundary', () => {
    const nye = Math.floor(new Date(2024, 11, 31, 23, 59, 0).getTime() / 1000);
    expect(bucketLabel(nye, 60)).toBe('23:59');
    expect(bucketLabel(nye, 86400)).toBe('Dec 31');
  });
});

describe('toChartData', () => {
  function result(s: MetricsSeries[], resolution = 60): MetricsResult {
    return { from: 0, to: 600, resolution, groupBy: 'command', series: s, seriesOmitted: 0 };
  }

  it('returns empty data for null', () => {
    expect(toChartData(null, 'memory')).toEqual({ labels: [], timestamps: [], datasets: [] });
  });

  it('returns empty data for no series', () => {
    expect(toChartData(result([]), 'memory').datasets).toEqual([]);
  });

  it('aligns disjoint series onto a shared axis, padding gaps with null', () => {
    const got = toChartData(
      result([series('a', [pt(0, 10), pt(120, 30)]), series('b', [pt(60, 20)])]),
      'memory',
    );
    expect(got.timestamps).toEqual([0, 60, 120]);
    expect(got.datasets[0].data).toEqual([10, null, 30]);
    expect(got.datasets[1].data).toEqual([null, 20, null]);
  });

  it('sorts timestamps ascending regardless of input order', () => {
    const got = toChartData(result([series('a', [pt(120, 1), pt(0, 2), pt(60, 3)])]), 'memory');
    expect(got.timestamps).toEqual([0, 60, 120]);
    expect(got.datasets[0].data).toEqual([2, 3, 1]);
  });

  it('emits one label per timestamp', () => {
    const got = toChartData(result([series('a', [pt(0, 1), pt(60, 2)])]), 'memory');
    expect(got.labels).toHaveLength(got.timestamps.length);
  });

  it('assigns colour indices in dataset order', () => {
    const got = toChartData(result([series('a', [pt(0, 1)]), series('b', [pt(0, 2)])]), 'memory');
    expect(got.datasets.map((d) => d.colorIndex)).toEqual([0, 1]);
  });

  it('reads the cpu value when charting cpu', () => {
    const got = toChartData(result([series('a', [pt(0, 500, 42)])]), 'cpu');
    expect(got.datasets[0].data).toEqual([42]);
  });

  it('caps at the palette size, folding the rest into Other', () => {
    const many = Array.from({ length: 20 }, (_, i) => series(`s${i}`, [pt(0, i + 1)]));
    const got = toChartData(result(many), 'memory');
    expect(got.datasets).toHaveLength(8);
    expect(got.datasets[7].label).toBe(OTHER_LABEL);
  });

  it('falls back to a 60s bucket when the resolution is missing', () => {
    const got = toChartData(result([series('a', [pt(0, 1)])], 0), 'memory');
    expect(got.labels).toHaveLength(1);
  });
});

describe('toFrequencyChartData', () => {
  function freq(series: { key: string; counts: number[] }[], resolution = 3600): FrequencyResult {
    const ts = series[0]?.counts.map((_, i) => i * resolution) ?? [];
    return {
      from: 0,
      to: ts.length * resolution,
      resolution,
      groupBy: 'command',
      total: series.reduce((n, s) => n + s.counts.reduce((a, b) => a + b, 0), 0),
      seriesOmitted: 0,
      series: series.map((s) => ({
        key: s.key,
        label: s.key,
        points: s.counts.map((count, i) => ({ t: i * resolution, count })),
        total: s.counts.reduce((a, b) => a + b, 0),
      })),
    };
  }

  it('returns empty data for null', () => {
    expect(toFrequencyChartData(null)).toEqual({ labels: [], timestamps: [], datasets: [] });
  });

  it('returns empty data for no series', () => {
    expect(toFrequencyChartData(freq([])).datasets).toEqual([]);
  });

  it('keeps zero buckets as zeros, never nulls', () => {
    // A bucket where a command was not run is real information on a stacked
    // chart; a null would render as missing data instead.
    const got = toFrequencyChartData(freq([{ key: 'a', counts: [3, 0, 5] }]));
    expect(got.datasets[0].data).toEqual([3, 0, 5]);
    expect(got.datasets[0].data).not.toContain(null);
  });

  it('shares one bucket axis across series', () => {
    const got = toFrequencyChartData(
      freq([
        { key: 'a', counts: [1, 2] },
        { key: 'b', counts: [0, 4] },
      ]),
    );
    expect(got.timestamps).toEqual([0, 3600]);
    expect(got.labels).toHaveLength(2);
    expect(got.datasets.map((d) => d.data)).toEqual([
      [1, 2],
      [0, 4],
    ]);
  });

  it('assigns colour indices in dataset order', () => {
    const got = toFrequencyChartData(
      freq([
        { key: 'a', counts: [1] },
        { key: 'b', counts: [1] },
      ]),
    );
    expect(got.datasets.map((d) => d.colorIndex)).toEqual([0, 1]);
  });

  it('folds the least-run series into Other past the ramp count', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ key: `s${i}`, counts: [i + 1, i + 1] }));
    const got = toFrequencyChartData(freq(many), 8);
    expect(got.datasets).toHaveLength(8);
    expect(got.datasets[7].label).toBe(OTHER_LABEL);
  });

  it('sums the folded tail bucket by bucket', () => {
    const got = toFrequencyChartData(
      freq([
        { key: 'big', counts: [100, 100] },
        { key: 'a', counts: [1, 2] },
        { key: 'b', counts: [3, 4] },
      ]),
      2,
    );
    expect(got.datasets[1].label).toBe(OTHER_LABEL);
    expect(got.datasets[1].data).toEqual([4, 6]);
  });

  it('falls back to an hourly label when the resolution is missing', () => {
    const r = freq([{ key: 'a', counts: [1] }]);
    r.resolution = 0;
    expect(toFrequencyChartData(r).labels).toHaveLength(1);
  });
});

describe('bubbleRadius', () => {
  it('returns the minimum for a zero value', () => {
    expect(bubbleRadius(0, 100, 3, 20)).toBe(3);
  });

  it('returns the maximum at the peak', () => {
    expect(bubbleRadius(100, 100, 3, 20)).toBe(20);
  });

  it('scales by area, not by radius', () => {
    // A quarter of the max must be half the radial span, so the drawn *area*
    // is a quarter. Linear radius scaling would put this at 3 + 0.25*17.
    expect(bubbleRadius(25, 100, 3, 20)).toBeCloseTo(3 + 0.5 * 17, 6);
  });

  it('is monotonic', () => {
    const rs = [0, 10, 25, 50, 75, 100].map((v) => bubbleRadius(v, 100));
    for (let i = 1; i < rs.length; i++) {
      expect(rs[i]).toBeGreaterThanOrEqual(rs[i - 1]);
    }
  });

  const guards: [string, number, number][] = [
    ['zero max', 50, 0],
    ['negative max', 50, -10],
    ['negative value', -50, 100],
    ['NaN value', NaN, 100],
  ];

  it.each(guards)('falls back to the minimum for %s', (_name, value, max) => {
    expect(bubbleRadius(value, max, 3, 20)).toBe(3);
  });

  it('clamps a value above the max', () => {
    expect(bubbleRadius(500, 100, 3, 20)).toBe(20);
  });
});

describe('profileBinSize', () => {
  it('splits the range into the requested number of bins', () => {
    expect(profileBinSize(260, 26)).toBe(10);
  });

  const guards: [string, number][] = [
    ['zero max', 0],
    ['negative max', -5],
    ['NaN max', NaN],
  ];

  it.each(guards)('returns a safe bin for %s', (_name, max) => {
    expect(profileBinSize(max)).toBe(1);
  });

  it('returns a safe bin for zero bins', () => {
    expect(profileBinSize(100, 0)).toBe(1);
  });
});

describe('toBubbleData', () => {
  function result(s: MetricsSeries[]): MetricsResult {
    return { from: 0, to: 7200, resolution: 3600, groupBy: 'command', series: s, seriesOmitted: 0 };
  }

  // A point whose average and peak are set independently.
  function profilePt(t: number, avg: number, peak: number): MetricsPoint {
    return { t, n: 20, rssAvg: avg, rssPeak: peak, cpuAvg: 0, cpuPeak: 0 };
  }

  it('returns empty data for null', () => {
    expect(toBubbleData(null).datasets).toEqual([]);
  });

  it('returns empty data for no series', () => {
    expect(toBubbleData(result([])).datasets).toEqual([]);
  });

  it('returns empty data when every sample is zero', () => {
    expect(toBubbleData(result([series('a', [profilePt(0, 0, 0)])])).datasets).toEqual([]);
  });

  it('puts typical memory on x and peak on y', () => {
    const got = toBubbleData(result([series('a', [profilePt(0, 500, 1000)])]));
    const point = got.datasets[0].data[0];
    expect(point.x).toBeCloseTo(500, 0);
    expect(point.y).toBeCloseTo(1000, 0);
  });

  it('collapses repeated footprints into one bubble and counts them', () => {
    // The same behaviour three times over should be one big bubble, not three
    // identical small ones stacked invisibly.
    const got = toBubbleData(
      result([series('a', [profilePt(0, 500, 1000), profilePt(1, 500, 1000), profilePt(2, 500, 1000)])]),
    );
    expect(got.datasets[0].data).toHaveLength(1);
    expect(got.datasets[0].data[0].count).toBe(3);
    expect(got.maxCount).toBe(3);
  });

  it('keeps distinct footprints apart', () => {
    const got = toBubbleData(
      result([series('a', [profilePt(0, 100, 200), profilePt(1, 900, 1000)])]),
    );
    expect(got.datasets[0].data).toHaveLength(2);
  });

  it('sizes the most frequent bubble largest', () => {
    const pts = [
      profilePt(0, 100, 200),
      profilePt(1, 100, 200),
      profilePt(2, 100, 200),
      profilePt(3, 900, 1000),
    ];
    const got = toBubbleData(result([series('a', pts)]));
    const common = got.datasets[0].data.find((d) => d.count === 3)!;
    const rare = got.datasets[0].data.find((d) => d.count === 1)!;
    expect(common.r).toBeGreaterThan(rare.r);
  });

  it('draws rarer bubbles last so they are not hidden under common ones', () => {
    const pts = [profilePt(0, 900, 1000), profilePt(1, 100, 200), profilePt(2, 100, 200)];
    const counts = toBubbleData(result([series('a', pts)])).datasets[0].data.map((d) => d.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('scales radii against the global maximum, not per series', () => {
    const got = toBubbleData(
      result([
        series('busy', [profilePt(0, 100, 200), profilePt(1, 100, 200)]),
        series('quiet', [profilePt(2, 100, 200)]),
      ]),
    );
    expect(got.maxCount).toBe(2);
    expect(got.datasets[0].data[0].r).toBeGreaterThan(got.datasets[1].data[0].r);
  });

  it('reports the axis maximum for the diagonal guide', () => {
    const got = toBubbleData(result([series('a', [profilePt(0, 500, 1200)])]));
    expect(got.axisMax).toBe(1200);
  });

  it('caps series at the palette size', () => {
    const many = Array.from({ length: 20 }, (_, i) => series(`s${i}`, [profilePt(0, i + 1, (i + 1) * 2)]));
    expect(toBubbleData(result(many)).datasets).toHaveLength(8);
  });

  it('assigns colour indices in dataset order', () => {
    const got = toBubbleData(
      result([series('a', [profilePt(0, 100, 200)]), series('b', [profilePt(0, 300, 400)])]),
    );
    expect(got.datasets.map((d) => d.colorIndex)).toEqual([0, 1]);
  });
});
