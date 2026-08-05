import { describe, it, expect } from 'vitest';
import { PANELS, visiblePanels, isPanelVisible, togglePanel } from './dashboardPanels';
import type { AppSettings, PanelId } from '../types';

const ALL: PanelId[] = ['stats', 'memory', 'frequency', 'activity'];

function settings(panels?: PanelId[]): AppSettings {
  return { schemaVersion: 1, metricsEnabled: true, retentionDays: 365, panels: panels as PanelId[] };
}

describe('PANELS', () => {
  it('covers every panel id exactly once', () => {
    expect(PANELS.map((p) => p.id)).toEqual(ALL);
  });

  it('gives every panel a label and a description', () => {
    for (const p of PANELS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });
});

describe('visiblePanels', () => {
  const cases: [string, AppSettings | null | undefined, PanelId[]][] = [
    ['null settings shows everything', null, ALL],
    ['undefined settings shows everything', undefined, ALL],
    ['missing panels shows everything', settings(undefined), ALL],
    ['empty list falls back to everything', settings([]), ALL],
    ['a subset is respected', settings(['memory']), ['memory']],
    ['two panels', settings(['activity', 'stats']), ['stats', 'activity']],
    ['all four', settings(ALL), ALL],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(visiblePanels(input)).toEqual(expected);
  });

  it('returns canonical order, not stored order', () => {
    expect(visiblePanels(settings(['activity', 'frequency', 'stats']))).toEqual(['stats', 'frequency', 'activity']);
  });

  it('drops unknown ids', () => {
    const stale = settings(['memory', 'traces' as PanelId]);
    expect(visiblePanels(stale)).toEqual(['memory']);
  });

  it('falls back to everything when only unknown ids remain', () => {
    // A stale config must never leave the dashboard blank.
    expect(visiblePanels(settings(['nope' as PanelId]))).toEqual(ALL);
  });

  it('collapses duplicates', () => {
    expect(visiblePanels(settings(['frequency', 'frequency']))).toEqual(['frequency']);
  });
});

describe('isPanelVisible', () => {
  it('is true for a chosen panel', () => {
    expect(isPanelVisible(settings(['memory']), 'memory')).toBe(true);
  });

  it('is false for an unchosen one', () => {
    expect(isPanelVisible(settings(['memory']), 'frequency')).toBe(false);
  });

  it('is true for everything with no settings', () => {
    for (const id of ALL) {
      expect(isPanelVisible(null, id)).toBe(true);
    }
  });
});

describe('togglePanel', () => {
  it('removes a present panel', () => {
    expect(togglePanel(['stats', 'memory'], 'memory')).toEqual(['stats']);
  });

  it('adds an absent panel', () => {
    expect(togglePanel(['stats'], 'frequency')).toEqual(['stats', 'frequency']);
  });

  it('returns canonical order when adding', () => {
    expect(togglePanel(['activity'], 'stats')).toEqual(['stats', 'activity']);
  });

  it('can empty the list — visiblePanels handles the fallback', () => {
    expect(togglePanel(['stats'], 'stats')).toEqual([]);
  });

  it('round-trips', () => {
    const once = togglePanel(ALL, 'frequency');
    expect(togglePanel(once, 'frequency')).toEqual(ALL);
  });
});
