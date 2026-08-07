import { describe, it, expect } from 'vitest';
import { dayKey, heatLevel, buildHeatmapGrid, cellTooltip, HEAT_COLORS } from './heatmap';
import type { ActivityDay } from '../types';

function day(date: string, total: number, extra: Partial<ActivityDay> = {}): ActivityDay {
  return { date, total, success: total, fail: 0, stopped: 0, durMs: 0, ...extra };
}

describe('dayKey', () => {
  const cases: [string, Date, string][] = [
    ['zero-pads month and day', new Date(2024, 0, 5), '2024-01-05'],
    ['two-digit month and day', new Date(2024, 11, 25), '2024-12-25'],
    ['local midnight', new Date(2024, 5, 1, 0, 0, 0), '2024-06-01'],
    ['just before midnight stays on the same day', new Date(2024, 5, 1, 23, 59, 59), '2024-06-01'],
    ['leap day', new Date(2024, 1, 29), '2024-02-29'],
  ];

  it.each(cases)('%s', (_name, date, expected) => {
    expect(dayKey(date)).toBe(expected);
  });

  it('uses local time, so the key matches the wall clock', () => {
    // 10am local can never roll into another date.
    const d = new Date(2024, 2, 10, 10, 0, 0);
    expect(dayKey(d)).toBe('2024-03-10');
  });
});

describe('heatLevel', () => {
  const cases: [string, number, number, number][] = [
    ['no runs is level 0', 0, 10, 0],
    ['any run is at least level 1', 1, 100, 1],
    ['the busiest day is level 4', 10, 10, 4],
    ['a single run on a single-run history is level 4', 1, 1, 4],
    ['first quartile', 25, 100, 1],
    ['second quartile', 50, 100, 2],
    ['third quartile', 75, 100, 3],
    ['fourth quartile', 76, 100, 4],
    ['zero max guards against divide-by-zero', 5, 0, 0],
    ['negative count is level 0', -3, 10, 0],
    ['count above max clamps to 4', 50, 10, 4],
  ];

  it.each(cases)('%s', (_name, count, max, expected) => {
    expect(heatLevel(count, max)).toBe(expected);
  });

  it('has a colour for every level', () => {
    expect(HEAT_COLORS).toHaveLength(5);
  });

  // Busier is darker. The ramp reads correctly either way round at a glance,
  // so nothing else would catch it being reversed — hence an explicit check on
  // the direction rather than just the count.
  it('darkens monotonically as activity rises', () => {
    const active = HEAT_COLORS.slice(1).map(luminance);
    for (let i = 1; i < active.length; i++) {
      expect(active[i]).toBeLessThan(active[i - 1]);
    }
  });

  // The busiest level still has to stand apart from an empty day, which is the
  // cost of darkening rather than brightening on a dark card.
  it('keeps the busiest level distinct from an empty one', () => {
    const empty = luminance(HEAT_COLORS[0]);
    const busiest = luminance(HEAT_COLORS[4]);
    expect(busiest).toBeGreaterThan(empty * 1.5);
  });
});

/** Relative luminance, enough to compare two swatches of the same hue. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('buildHeatmapGrid', () => {
  const today = new Date(2024, 2, 15); // Friday 2024-03-15

  it('lays out a full year of cells', () => {
    const grid = buildHeatmapGrid([], today, 365);
    const cells = grid.weeks.flat().filter(Boolean);
    expect(cells).toHaveLength(365);
  });

  it('uses columns of exactly seven rows', () => {
    const grid = buildHeatmapGrid([], today, 365);
    for (const week of grid.weeks) {
      expect(week).toHaveLength(7);
    }
  });

  it('pads the first column when the window does not start on a Sunday', () => {
    // 7 days ending Fri 2024-03-15 starts Sat 2024-03-09 (getDay() === 6).
    const grid = buildHeatmapGrid([], today, 7);
    const leading = grid.weeks[0].findIndex((c) => c !== null);
    expect(leading).toBe(6);
  });

  it('pads the trailing column so every week is full', () => {
    const grid = buildHeatmapGrid([], today, 7);
    const last = grid.weeks[grid.weeks.length - 1];
    expect(last).toHaveLength(7);
  });

  it('ends on today', () => {
    const grid = buildHeatmapGrid([], today, 30);
    const cells = grid.weeks.flat().filter(Boolean);
    expect(cells[cells.length - 1]!.date).toBe('2024-03-15');
  });

  it('maps counts onto the right dates', () => {
    const grid = buildHeatmapGrid([day('2024-03-15', 5), day('2024-03-14', 2)], today, 7);
    const cells = grid.weeks.flat().filter(Boolean);
    const byDate = new Map(cells.map((c) => [c!.date, c!]));
    expect(byDate.get('2024-03-15')!.day.total).toBe(5);
    expect(byDate.get('2024-03-14')!.day.total).toBe(2);
    expect(byDate.get('2024-03-13')!.day.total).toBe(0);
  });

  it('ignores dates outside the window', () => {
    const grid = buildHeatmapGrid([day('2020-01-01', 99)], today, 7);
    const cells = grid.weeks.flat().filter(Boolean);
    expect(cells.every((c) => c!.day.total === 0)).toBe(true);
  });

  it('reports totals, max, and active days', () => {
    const grid = buildHeatmapGrid(
      [day('2024-03-15', 5), day('2024-03-14', 2), day('2024-03-13', 0)],
      today,
      7,
    );
    expect(grid.maxCount).toBe(5);
    expect(grid.totalRuns).toBe(7);
    expect(grid.activeDays).toBe(2);
  });

  it('gives every cell level 0 when there is no activity', () => {
    const grid = buildHeatmapGrid([], today, 30);
    const cells = grid.weeks.flat().filter(Boolean);
    expect(cells.every((c) => c!.level === 0)).toBe(true);
    expect(grid.maxCount).toBe(0);
  });

  it('emits one month label per month, at its first column', () => {
    const grid = buildHeatmapGrid([], today, 90);
    const labels = grid.monthLabels.map((m) => m.label);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(new Set(labels).size).toBe(labels.length); // no repeats within 90 days
    expect(grid.monthLabels[0].col).toBe(0);
    // Columns advance monotonically.
    const cols = grid.monthLabels.map((m) => m.col);
    expect([...cols].sort((a, b) => a - b)).toEqual(cols);
  });

  // The layout places month labels by week index into a grid with one column
  // per week, and pads every week to seven rows so the weekday labels line up.
  // Both only hold if the grid keeps these shapes, and neither is visible from
  // the CSS side.
  it('keeps every month label inside the week range', () => {
    const grid = buildHeatmapGrid([], today, 365);
    for (const m of grid.monthLabels) {
      expect(m.col).toBeGreaterThanOrEqual(0);
      expect(m.col).toBeLessThan(grid.weeks.length);
    }
  });

  it('pads every week to seven rows', () => {
    const grid = buildHeatmapGrid([], today, 365);
    for (const week of grid.weeks) {
      expect(week).toHaveLength(7);
    }
  });

  it('handles a one-day span', () => {
    const grid = buildHeatmapGrid([day('2024-03-15', 3)], today, 1);
    const cells = grid.weeks.flat().filter(Boolean);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.level).toBe(4);
  });

  it('lets the last duplicate date win rather than throwing', () => {
    const grid = buildHeatmapGrid([day('2024-03-15', 1), day('2024-03-15', 9)], today, 7);
    const cells = grid.weeks.flat().filter(Boolean);
    const cell = cells.find((c) => c!.date === '2024-03-15')!;
    expect(cell.day.total).toBe(9);
  });
});

describe('cellTooltip', () => {
  const mk = (d: ActivityDay) => ({ date: d.date, day: d, level: 0 as const });

  it('describes an empty day', () => {
    expect(cellTooltip(mk(day('2024-03-15', 0)))).toBe('No runs on 2024-03-15');
  });

  it('uses the singular for one run', () => {
    expect(cellTooltip(mk(day('2024-03-15', 1)))).toContain('1 run on');
  });

  it('uses the plural for several', () => {
    expect(cellTooltip(mk(day('2024-03-15', 3)))).toContain('3 runs on');
  });

  it('breaks down outcomes', () => {
    const d = day('2024-03-15', 6, { success: 3, fail: 2, stopped: 1 });
    const text = cellTooltip(mk(d));
    expect(text).toContain('3 ok');
    expect(text).toContain('2 failed');
    expect(text).toContain('1 stopped');
  });

  it('omits categories with no runs', () => {
    const d = day('2024-03-15', 2, { success: 2, fail: 0, stopped: 0 });
    const text = cellTooltip(mk(d));
    expect(text).toContain('2 ok');
    expect(text).not.toContain('failed');
  });
});
