import { describe, it, expect } from 'vitest';
import {
  CHART_COLORS,
  SERIES_PALETTE,
  MAX_SERIES,
  seriesColor,
  hexToRgba,
  gradientStops,
  FREQUENCY_RAMPS,
  frequencyStops,
  frequencyLineColor,
  pointRadiusFor,
  progressiveAnimation,
  baseLineOptions,
} from './chartTheme';
import { isValidColor } from './envColors';

describe('SERIES_PALETTE', () => {
  it('has one entry per available hue slot', () => {
    expect(SERIES_PALETTE.length).toBe(MAX_SERIES);
    expect(MAX_SERIES).toBe(8);
  });

  it('contains only valid hex colours', () => {
    for (const hex of SERIES_PALETTE) {
      expect(isValidColor(hex), `${hex} is not a valid hex colour`).toBe(true);
    }
  });

  it('has no duplicates — a repeated hue would imply two series are the same', () => {
    expect(new Set(SERIES_PALETTE).size).toBe(SERIES_PALETTE.length);
  });
});

describe('CHART_COLORS', () => {
  // Guards against drift from the CSS custom properties in styles.css:1-17.
  const cases: [keyof typeof CHART_COLORS, string][] = [
    ['bg', '#0d1117'],
    ['surface', '#161b22'],
    ['border', '#30363d'],
    ['text', '#e6edf3'],
    ['muted', '#8b949e'],
    ['accent', '#58a6ff'],
  ];

  it.each(cases)('%s matches the theme variable', (key, expected) => {
    expect(CHART_COLORS[key]).toBe(expected);
  });
});

describe('seriesColor', () => {
  const cases: [string, number, string][] = [
    ['first slot', 0, SERIES_PALETTE[0]],
    ['second slot', 1, SERIES_PALETTE[1]],
    ['last slot', 7, SERIES_PALETTE[7]],
    ['clamps past the end rather than cycling', 8, SERIES_PALETTE[7]],
    ['clamps far past the end', 999, SERIES_PALETTE[7]],
    ['clamps negatives', -1, SERIES_PALETTE[0]],
    ['floors fractions', 2.7, SERIES_PALETTE[2]],
    ['handles NaN', NaN, SERIES_PALETTE[0]],
  ];

  it.each(cases)('%s', (_name, index, expected) => {
    expect(seriesColor(index)).toBe(expected);
  });
});

describe('hexToRgba', () => {
  const cases: [string, string, number, string][] = [
    ['six-digit hex', '#3987e5', 1, 'rgba(57, 135, 229, 1)'],
    ['three-digit hex expands', '#abc', 1, 'rgba(170, 187, 204, 1)'],
    ['fractional alpha', '#000000', 0.34, 'rgba(0, 0, 0, 0.34)'],
    ['zero alpha', '#ffffff', 0, 'rgba(255, 255, 255, 0)'],
    ['uppercase hex', '#FF8800', 1, 'rgba(255, 136, 0, 1)'],
    ['alpha above 1 clamps', '#000000', 5, 'rgba(0, 0, 0, 1)'],
    ['alpha below 0 clamps', '#000000', -2, 'rgba(0, 0, 0, 0)'],
    ['missing hash still parses', '3987e5', 1, 'rgba(57, 135, 229, 1)'],
  ];

  it.each(cases)('%s', (_name, hex, alpha, expected) => {
    expect(hexToRgba(hex, alpha)).toBe(expected);
  });
});

describe('gradientStops', () => {
  const alpha = (c: string) => Number(c.split(',').pop()!.replace(')', ''));

  it('spans the full chart height', () => {
    const stops = gradientStops('#3987e5');
    expect(stops[0].offset).toBe(0);
    expect(stops[stops.length - 1].offset).toBe(1);
  });

  it('uses more than two stops so the band does not read as a flat wash', () => {
    expect(gradientStops('#3987e5').length).toBeGreaterThan(2);
  });

  it('keeps the series hue in every stop', () => {
    for (const stop of gradientStops('#3987e5')) {
      expect(stop.color).toContain('57, 135, 229');
    }
  });

  it('fades monotonically to fully transparent', () => {
    const stops = gradientStops('#199e70');
    for (let i = 1; i < stops.length; i++) {
      expect(alpha(stops[i].color)).toBeLessThan(alpha(stops[i - 1].color));
      expect(stops[i].offset).toBeGreaterThan(stops[i - 1].offset);
    }
    expect(alpha(stops[stops.length - 1].color)).toBe(0);
  });

  it('starts saturated enough to be visible on the dark background', () => {
    expect(alpha(gradientStops('#199e70')[0].color)).toBeGreaterThan(0.4);
  });
});

describe('pointRadiusFor', () => {
  const cases: [string, number, number][] = [
    ['no points', 0, 0],
    ['a handful gets clear dots', 8, 3.5],
    ['at the sparse boundary', 30, 3.5],
    ['just past it, smaller dots', 31, 2],
    ['at the medium boundary', 80, 2],
    ['dense series drops markers entirely', 81, 0],
    ['very dense', 5000, 0],
    ['negative is treated as none', -5, 0],
    ['NaN is treated as none', NaN, 0],
  ];

  it.each(cases)('%s', (_name, count, expected) => {
    expect(pointRadiusFor(count)).toBe(expected);
  });

  it('never grows with density', () => {
    const counts = [1, 10, 30, 31, 80, 81, 500];
    const radii = counts.map(pointRadiusFor);
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeLessThanOrEqual(radii[i - 1]);
    }
  });
});

describe('progressiveAnimation', () => {
  it('returns an x and y animation', () => {
    const anim = progressiveAnimation(10);
    expect(anim).toHaveProperty('x');
    expect(anim).toHaveProperty('y');
  });

  it('never produces a non-finite delay for zero points', () => {
    const anim = progressiveAnimation(0);
    expect(Number.isFinite(anim.x.duration as number)).toBe(true);
    expect(anim.x.duration as number).toBeGreaterThan(0);
  });

  it('spreads the total across the points', () => {
    const anim = progressiveAnimation(60, 1200);
    expect(anim.x.duration).toBe(20); // 1200 / 60
  });

  it('clamps so a dense series is not imperceptible', () => {
    const anim = progressiveAnimation(100000, 1200);
    expect(anim.x.duration as number).toBeGreaterThanOrEqual(2);
  });

  it('clamps so a sparse series does not crawl', () => {
    const anim = progressiveAnimation(1, 1200);
    expect(anim.x.duration as number).toBeLessThanOrEqual(60);
  });

  it('staggers each point by its index', () => {
    const anim = progressiveAnimation(10, 1200);
    const delayFn = anim.x.delay as (ctx: any) => number;
    expect(delayFn({ type: 'data', index: 0 })).toBe(0);
    expect(delayFn({ type: 'data', index: 3 })).toBe(3 * (anim.x.duration as number));
  });

  it('does not replay for a point that already animated', () => {
    const anim = progressiveAnimation(10, 1200);
    const delayFn = anim.x.delay as (ctx: any) => number;
    const ctx: any = { type: 'data', index: 5 };
    expect(delayFn(ctx)).toBeGreaterThan(0);
    expect(delayFn(ctx)).toBe(0); // xStarted is now set
  });

  it('ignores non-data animation contexts', () => {
    const anim = progressiveAnimation(10);
    const delayFn = anim.x.delay as (ctx: any) => number;
    expect(delayFn({ type: 'resize', index: 4 })).toBe(0);
  });
});

describe('baseLineOptions', () => {
  it('propagates the stacked flag to both axes', () => {
    const stacked = baseLineOptions({ stacked: true, yLabel: 'Memory' });
    expect(stacked.scales.y.stacked).toBe(true);
    expect(stacked.scales.x.stacked).toBe(true);

    const flat = baseLineOptions({ stacked: false, yLabel: 'CPU' });
    expect(flat.scales.y.stacked).toBe(false);
  });

  it('uses the theme colours for chrome, never a series hue', () => {
    const opts = baseLineOptions({ stacked: false, yLabel: 'CPU' });
    expect(opts.scales.y.grid.color).toBe(CHART_COLORS.border);
    expect(opts.scales.y.ticks.color).toBe(CHART_COLORS.muted);
    // A near-opaque form of --surface (#161b22 === rgb(22, 27, 34)).
    expect(opts.plugins.tooltip.backgroundColor).toBe('rgba(22, 27, 34, 0.96)');
    expect(opts.plugins.tooltip.borderColor).toBe(CHART_COLORS.border);
    expect(opts.plugins.legend.labels.color).toBe(CHART_COLORS.muted);
  });

  it('sets the y-axis title', () => {
    const opts = baseLineOptions({ stacked: true, yLabel: 'Memory' });
    expect(opts.scales.y.title.text).toBe('Memory');
  });

  it('uses an index tooltip so every series is listed at once', () => {
    const opts = baseLineOptions({ stacked: true, yLabel: 'Memory' });
    expect(opts.interaction.mode).toBe('index');
    expect(opts.interaction.intersect).toBe(false);
  });

  it('does not maintain an aspect ratio (the wrapper fixes the height)', () => {
    expect(baseLineOptions({ stacked: true, yLabel: 'x' }).maintainAspectRatio).toBe(false);
  });
});

describe('FREQUENCY_RAMPS', () => {
  it('has one ramp per series slot', () => {
    expect(FREQUENCY_RAMPS.length).toBe(MAX_SERIES);
  });

  it('opens with the reference design colours', () => {
    // Sampled pixel-by-pixel from the reference image; the first ramp is its
    // magenta→orange band and the second its blue→cyan band.
    expect(FREQUENCY_RAMPS[0][0]).toBe('#fbb12c');
    expect(FREQUENCY_RAMPS[0][FREQUENCY_RAMPS[0].length - 1]).toBe('#c524b2');
    expect(FREQUENCY_RAMPS[1][0]).toBe('#04d8fd');
    expect(FREQUENCY_RAMPS[1][FREQUENCY_RAMPS[1].length - 1]).toBe('#1e88e5');
  });

  it('contains only valid hex colours', () => {
    for (const ramp of FREQUENCY_RAMPS) {
      expect(ramp.length).toBeGreaterThan(1);
      for (const hex of ramp) {
        expect(isValidColor(hex), `${hex} is not valid`).toBe(true);
      }
    }
  });
});

describe('frequencyStops', () => {
  it('spans the plot from 0 to 1', () => {
    const stops = frequencyStops(0);
    expect(stops[0].offset).toBe(0);
    expect(stops[stops.length - 1].offset).toBe(1);
  });

  it('spaces stops evenly', () => {
    const stops = frequencyStops(0);
    const step = 1 / (stops.length - 1);
    stops.forEach((s, i) => expect(s.offset).toBeCloseTo(i * step, 6));
  });

  it('passes hex straight through at full alpha', () => {
    expect(frequencyStops(0)[0].color).toBe('#fbb12c');
  });

  it('converts to rgba below full alpha', () => {
    expect(frequencyStops(0, 0.9)[0].color).toBe('rgba(251, 177, 44, 0.9)');
  });

  it('clamps an out-of-range index rather than cycling', () => {
    const last = FREQUENCY_RAMPS.length - 1;
    expect(frequencyStops(99)[0].color).toBe(FREQUENCY_RAMPS[last][0]);
    expect(frequencyStops(-5)[0].color).toBe(FREQUENCY_RAMPS[0][0]);
  });
});

describe('frequencyLineColor', () => {
  it('takes the midpoint of the ramp so the line reads against its own fill', () => {
    expect(frequencyLineColor(0)).toBe(FREQUENCY_RAMPS[0][3]);
  });

  it('is unique per slot', () => {
    const seen = FREQUENCY_RAMPS.map((_, i) => frequencyLineColor(i));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('clamps out-of-range indices', () => {
    expect(frequencyLineColor(999)).toBe(frequencyLineColor(FREQUENCY_RAMPS.length - 1));
  });
});
