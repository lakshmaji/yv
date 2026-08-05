// Turns world *data* into the SVG path strings each layer draws. Kept out of
// the components so the shape maths is testable, and out of world.ts so the
// generated world stays pure numbers.

import { lerp, polygonPath, type Pt } from './geometry';
import type { Peak, Settlement, Tree } from './world';

export interface PeakShape {
  /** Full silhouette, drawn in the mid rock tone. */
  body: string;
  /** Sun-facing left facet, drawn lighter — this is what gives the spire volume. */
  lit: string;
  /** Cast shadow on the ground, so the spire sits on the terrain. */
  base: string;
  /** Snow cap, null below the treeline. */
  snow: string | null;
}

/**
 * A spire as four flat facets rather than a shaded gradient. The reference has
 * hard-edged rock, and facets read as rock at any zoom without a filter.
 */
export function peakShape(peak: Peak): PeakShape {
  const { x, y, baseR, height, tilt } = peak;
  const apex: Pt = { x: x + tilt, y: y - height };
  const bl: Pt = { x: x - baseR, y };
  const br: Pt = { x: x + baseR, y };
  const midL: Pt = { x: lerp(bl.x, apex.x, 0.42), y: lerp(bl.y, apex.y, 0.5) + height * 0.06 };
  const midR: Pt = { x: lerp(br.x, apex.x, 0.42), y: lerp(br.y, apex.y, 0.5) + height * 0.06 };
  const foot: Pt = { x: x + tilt * 0.3, y };

  const edge = (t: number, toward: Pt): Pt => ({
    x: lerp(apex.x, toward.x, t),
    y: lerp(apex.y, toward.y, t),
  });

  return {
    body: polygonPath([bl, midL, apex, midR, br]),
    lit: polygonPath([bl, midL, apex, foot]),
    base: polygonPath([
      { x: bl.x, y },
      { x: x - baseR * 0.4, y: y + baseR * 0.22 },
      { x: x + baseR * 0.5, y: y + baseR * 0.2 },
      { x: br.x, y },
    ]),
    snow: peak.snow
      ? polygonPath([
          apex,
          edge(0.34, midR),
          { x: lerp(apex.x, x, 0.4), y: apex.y + height * 0.26 },
          edge(0.3, midL),
        ])
      : null,
  };
}

export interface TreeShape {
  trunk: string;
  /** Two stacked canopy tiers: the lower wider one, then the lighter top. */
  canopyLower: string;
  canopyUpper: string;
}

/** A conifer: trunk plus two triangles. Drawn at the tree's own coordinates. */
export function treeShape(tree: Tree): TreeShape {
  const { x, y, size: s } = tree;
  const tw = Math.max(0.8, s * 0.09);
  return {
    trunk: polygonPath([
      { x: x - tw, y },
      { x: x + tw, y },
      { x: x + tw, y: y - s * 0.34 },
      { x: x - tw, y: y - s * 0.34 },
    ]),
    canopyLower: polygonPath([
      { x: x - s * 0.42, y: y - s * 0.22 },
      { x: x + s * 0.42, y: y - s * 0.22 },
      { x, y: y - s * 0.78 },
    ]),
    canopyUpper: polygonPath([
      { x: x - s * 0.3, y: y - s * 0.6 },
      { x: x + s * 0.3, y: y - s * 0.6 },
      { x, y: y - s },
    ]),
  };
}

export interface SettlementShape {
  /** Main body — walls, tent, or standing stones. */
  body: string;
  /** Roof or capstone; null for ruins, which have none left. */
  roof: string | null;
}

/** Tiny buildings. At this scale silhouette is all that survives, so keep it blocky. */
export function settlementShape(s: Settlement): SettlementShape {
  const { x, y } = s;
  if (s.kind === 'camp') {
    return {
      body: polygonPath([
        { x: x - 8, y: y + 2 },
        { x: x + 8, y: y + 2 },
        { x, y: y - 12 },
      ]),
      roof: null,
    };
  }
  if (s.kind === 'ruin') {
    return {
      body:
        polygonPath([
          { x: x - 9, y: y + 2 },
          { x: x - 4, y: y + 2 },
          { x: x - 4, y: y - 11 },
          { x: x - 9, y: y - 8 },
        ]) +
        ' ' +
        polygonPath([
          { x: x + 3, y: y + 2 },
          { x: x + 9, y: y + 2 },
          { x: x + 9, y: y - 7 },
          { x: x + 3, y: y - 13 },
        ]),
      roof: null,
    };
  }
  return {
    body: polygonPath([
      { x: x - 9, y: y + 2 },
      { x: x + 9, y: y + 2 },
      { x: x + 9, y: y - 8 },
      { x: x - 9, y: y - 8 },
    ]),
    roof: polygonPath([
      { x: x - 12, y: y - 7 },
      { x: x + 12, y: y - 7 },
      { x, y: y - 20 },
    ]),
  };
}
