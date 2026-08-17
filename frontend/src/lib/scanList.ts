import type { ScanHit } from '../types';

/** A row can be imported only if the file actually parsed. */
export function usable(hit: ScanHit): boolean {
  return !hit.error;
}

/**
 * Whether a hit belongs in the main list — it is new, it has changed since it
 * was last reviewed, or it is broken and its author should know.
 *
 * A file byte-identical to the one already imported is not a decision:
 * re-importing it does nothing. Listing those beside rows that do need
 * answering is what made a finished import look like it had failed, so they go
 * into a collapsed section instead of the list.
 */
export function needsDecision(hit: ScanHit): boolean {
  return !hit.unchanged;
}

/** New before changed, broken last. */
export function ordered(hits: ScanHit[]): ScanHit[] {
  const rank = (h: ScanHit) => (h.error ? 2 : h.exists ? 1 : 0);
  return [...hits].sort((a, b) => rank(a) - rank(b));
}

/**
 * Which rows arrive ticked: importable, genuinely new, and not already
 * reviewed.
 *
 * A replacement is deliberately left unticked. A scan of eighteen repositories
 * must not present eighteen pre-armed overwrites — adding a project the user
 * has never seen is additive, replacing one they have been editing is not.
 */
export function defaultSelection(hits: ScanHit[]): Set<string> {
  const sel = new Set<string>();
  for (const h of hits) {
    if (usable(h) && !h.exists && !h.unchanged) sel.add(h.path);
  }
  return sel;
}
