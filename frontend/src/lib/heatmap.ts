// Calendar-heatmap layout and colour scale. Pure so the week/day bucketing —
// the part that is easy to get subtly wrong — is covered by tests.

import type { ActivityDay } from '../types';

/**
 * Sequential ramp for the heatmap: a single blue hue stepping monotonically
 * from dark to light, so the colour encodes magnitude rather than identity.
 *
 * Level 0 is a faint blue-grey rather than the card's own --surface. Matching
 * the card made empty days invisible, so a year of history looked like a few
 * floating weeks instead of a full calendar with quiet stretches.
 */
export const HEAT_COLORS = ['#232b36', '#184f95', '#256abf', '#3987e5', '#86b6ef'] as const;

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface HeatCell {
  date: string;
  day: ActivityDay;
  level: HeatLevel;
}

export interface MonthLabel {
  /** Column index (week) this month's first cell falls in. */
  col: number;
  label: string;
}

export interface HeatmapGrid {
  /** Sunday-anchored columns of 7; leading/trailing padding is null. */
  weeks: (HeatCell | null)[][];
  monthLabels: MonthLabel[];
  maxCount: number;
  totalRuns: number;
  activeDays: number;
}

/** Local-time 'YYYY-MM-DD'. Local, not UTC, so "today" matches the wall clock. */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Buckets a count into one of four non-zero intensity steps.
 *
 * Any non-zero count is at least level 1: a day with a single run must be
 * visibly distinct from a day with none, however busy the busiest day was.
 */
export function heatLevel(count: number, max: number): HeatLevel {
  if (count <= 0 || max <= 0) return 0;
  if (count >= max) return 4;
  const ratio = count / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function emptyDay(date: string): ActivityDay {
  return { date, total: 0, success: 0, fail: 0, stopped: 0, durMs: 0 };
}

/**
 * Lays days out as GitHub does: one column per week, Sunday at the top. The
 * first column is padded with nulls when the window does not begin on a Sunday,
 * so weekday rows line up across the whole grid.
 */
export function buildHeatmapGrid(days: ActivityDay[], today: Date, span = 365): HeatmapGrid {
  const byDate = new Map(days.map((d) => [d.date, d]));

  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - (span - 1));

  let maxCount = 0;
  let totalRuns = 0;
  let activeDays = 0;
  for (const d of days) {
    if (d.total > maxCount) maxCount = d.total;
    totalRuns += d.total;
    if (d.total > 0) activeDays++;
  }

  const weeks: (HeatCell | null)[][] = [];
  const monthLabels: MonthLabel[] = [];
  let column: (HeatCell | null)[] = new Array(start.getDay()).fill(null);
  let lastMonth = -1;

  const cursor = new Date(start);
  while (cursor <= end) {
    const date = dayKey(cursor);
    const day = byDate.get(date) ?? emptyDay(date);
    column.push({ date, day, level: heatLevel(day.total, maxCount) });

    if (cursor.getMonth() !== lastMonth) {
      lastMonth = cursor.getMonth();
      monthLabels.push({
        col: weeks.length,
        label: cursor.toLocaleString('en-US', { month: 'short' }),
      });
    }

    if (column.length === 7) {
      weeks.push(column);
      column = [];
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  if (column.length > 0) {
    while (column.length < 7) column.push(null);
    weeks.push(column);
  }

  return { weeks, monthLabels, maxCount, totalRuns, activeDays };
}

/** Human-readable tooltip for one cell. */
export function cellTooltip(cell: HeatCell): string {
  const { day, date } = cell;
  if (day.total === 0) return `No runs on ${date}`;

  const parts: string[] = [];
  if (day.success) parts.push(`${day.success} ok`);
  if (day.fail) parts.push(`${day.fail} failed`);
  if (day.stopped) parts.push(`${day.stopped} stopped`);

  const runs = day.total === 1 ? '1 run' : `${day.total} runs`;
  return parts.length > 0 ? `${runs} on ${date} — ${parts.join(', ')}` : `${runs} on ${date}`;
}
