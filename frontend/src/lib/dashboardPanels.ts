// Which dashboard sections are visible. The user chooses in Settings; Go
// persists the list and normalises it (see internal/settings.NormalizePanels) —
// this mirror exists so the UI can react without a round trip.

import type { AppSettings, PanelId } from '../types';

export interface PanelDef {
  id: PanelId;
  label: string;
  description: string;
}

/**
 * Canonical render order. The stored list controls which panels appear, never
 * the order they appear in.
 */
export const PANELS: PanelDef[] = [
  { id: 'stats', label: 'Summary tiles', description: 'Totals for runs, peak memory, and active days' },
  { id: 'memory', label: 'Memory chart', description: 'Stacked memory use over time' },
  {
    id: 'frequency',
    label: 'Command usage frequency',
    description: 'How often each command, project, or group was run',
  },
  { id: 'activity', label: 'Activity calendar', description: 'One cell per day for the last year' },
];

const KNOWN = new Set<string>(PANELS.map((p) => p.id));
const ALL = PANELS.map((p) => p.id);

/**
 * The panels to render, in canonical order. Unknown IDs are dropped and an
 * empty result falls back to everything, so a stale or hand-edited config can
 * never leave the dashboard blank.
 */
export function visiblePanels(settings: AppSettings | null | undefined): PanelId[] {
  const stored = settings?.panels;
  if (!stored) return [...ALL];

  const chosen = new Set(stored.filter((p) => KNOWN.has(p)));
  if (chosen.size === 0) return [...ALL];

  return ALL.filter((id) => chosen.has(id));
}

/** Whether one panel should render under the given settings. */
export function isPanelVisible(settings: AppSettings | null | undefined, id: PanelId): boolean {
  return visiblePanels(settings).includes(id);
}

/** Toggles one panel, returning a new list in canonical order. */
export function togglePanel(panels: PanelId[], id: PanelId): PanelId[] {
  const next = new Set(panels);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return ALL.filter((p) => next.has(p));
}
