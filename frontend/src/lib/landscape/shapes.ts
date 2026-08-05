// Turns world *data* into the SVG path strings each layer draws. Kept out of
// the components so the shape maths is testable, and out of world.ts so the
// generated world stays pure numbers.

import { lerp, polygonPath, type Pt } from './geometry';
import type { Peak, Settlement, Shoulder, Tree } from './world';

/** Cast shadow at a mountain's foot, offset down-right away from the light. */
export interface PeakShadow {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface PeakShape {
  shadow: PeakShadow;
  /** Full closed silhouette, filled in the darkest tone. */
  body: string;
  /**
   * The silhouette's upper edge only, open so it can be stroked.
   *
   * Stroking `body` instead drew a hard line along the base as well, which made
   * every mountain look like a cardboard cutout standing on the grass.
   */
  outline: string;
  /** Sun-facing (left) facet. */
  lit: string;
  /** Away-facing (right) facet. Together with `lit` this tiles the silhouette. */
  shade: string;
  /** The front arête from summit to foot, stroked to sharpen the fold. */
  crease: string;
  /** Snow field, and the part of it on the shaded flank. Null below the treeline. */
  snow: string | null;
  snowShade: string | null;
  /** Talus blocks at the foot, in absolute coordinates. */
  scree: { cx: number; cy: number; r: number }[];
}

/** Polyline through the points, left open so it can be stroked as an edge. */
function openPath(points: readonly Pt[]): string {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');
}

/** Where a straight ridge from `apex` to `foot` crosses a given y. */
function crossY(apex: Pt, foot: Pt, targetY: number): Pt {
  const span = foot.y - apex.y;
  const t = span === 0 ? 0 : (targetY - apex.y) / span;
  return { x: lerp(apex.x, foot.x, t), y: targetY };
}

/**
 * A ridge from summit to base, as a polyline.
 *
 * The invariant that matters is that x stays monotone from apex to foot: the
 * silhouette has to remain a function of height. Break it and adjacent vertices
 * swap order, the outline crosses itself, and the mountain renders as shards.
 * So all three modifiers are bounded to stay well inside the ~0.2·baseR that
 * each step advances horizontally:
 *
 *   - `bow` curves the whole flank (convex or concave) — smooth, so its
 *     per-step delta is tiny;
 *   - `jitter` adds crag texture, bounded by MAX_CRAG;
 *   - a shoulder raises one vertex into a subordinate summit. It moves y freely
 *     — a saddle between two tops is non-monotone in y, which is exactly right —
 *     but barely touches x.
 */
function ridgeLine(
  apex: Pt,
  foot: Pt,
  jitter: readonly number[],
  bow: number,
  baseR: number,
  height: number,
  shoulders: readonly Shoulder[],
  side: -1 | 1,
): Pt[] {
  const steps = jitter.length;
  const pts: Pt[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i + 1) / (steps + 1);
    const j = jitter[i];
    // The bow peaks mid-flank and vanishes at both ends, so the summit stays
    // sharp and the foot stays put.
    const curve = side * bow * baseR * Math.sin(Math.PI * t);
    pts.push({
      x: lerp(apex.x, foot.x, t) + j * baseR + curve,
      // Only ever notch upward: a downward kink would cut into the silhouette
      // and read as a nick out of the rock rather than a crag on it.
      y: lerp(apex.y, foot.y, t) - Math.abs(j) * height * 0.3,
    });
  }

  for (const s of shoulders) {
    if (s.side !== side || steps === 0) continue;
    const idx = Math.min(steps - 1, Math.max(0, Math.round(s.at * (steps - 1))));
    pts[idx] = {
      x: pts[idx].x + side * baseR * 0.04,
      y: apex.y + height * (1 - s.h),
    };
  }

  // Enforce the invariant rather than trusting the bounds above to imply it: walk
  // apex to foot and clamp each x into the span still ahead. Cheap, and it means
  // a future tweak to bow or jitter can't quietly reintroduce a crossed outline.
  const descending = foot.x < apex.x;
  let prev = apex.x;
  for (const p of pts) {
    p.x = descending
      ? Math.max(foot.x, Math.min(prev, p.x))
      : Math.min(foot.x, Math.max(prev, p.x));
    prev = p.x;
  }
  return pts;
}

/**
 * A summit as two crag ridges, two facets and an irregular snow field.
 *
 * Flat facets rather than gradients: the reference has hard-edged rock, and
 * facets read as rock at any zoom without paying for a filter.
 */
export function peakShape(peak: Peak): PeakShape {
  const { x, y, baseR, height, tilt } = peak;
  const apex: Pt = { x: x + tilt, y: y - height };
  const bl: Pt = { x: x - baseR, y };
  const br: Pt = { x: x + baseR, y };
  // The fold sits off-centre, not under the summit. Split down the middle and
  // the two equal facets read as a tent; giving the sunlit side roughly two
  // thirds of the face reads as a mountain lit from the top-left.
  const foot: Pt = { x: x + tilt * 0.35 + baseR * 0.34, y };

  const left = ridgeLine(apex, bl, peak.ridgeL, peak.bowL, baseR, height, peak.shoulders, -1);
  const right = ridgeLine(apex, br, peak.ridgeR, peak.bowR, baseR, height, peak.shoulders, 1);

  const litFace = [bl, ...[...left].reverse(), apex, foot];
  const shadeFace = [apex, ...right, br, foot];

  let snow: string | null = null;
  let snowShade: string | null = null;
  if (peak.snow) {
    const snowY = apex.y + height * peak.snowline;
    const lEdge = crossY(apex, bl, snowY);
    const rEdge = crossY(apex, br, snowY);
    const creaseAt = crossY(apex, foot, snowY);

    // Tongues of snow running down the gullies, so the lower edge is ragged
    // instead of a straight line ruled across the summit.
    const tongues: Pt[] = [];
    for (let k = 1; k <= 3; k++) {
      const t = k / 4;
      tongues.push({
        x: lerp(rEdge.x, lEdge.x, t),
        y: snowY + height * (k % 2 === 1 ? 0.1 : 0.025),
      });
    }

    const above = (p: Pt): boolean => p.y < snowY;
    snow = polygonPath([
      apex,
      ...right.filter(above),
      rEdge,
      ...tongues,
      lEdge,
      ...[...left].reverse().filter(above),
    ]);
    snowShade = polygonPath([apex, ...right.filter(above), rEdge, tongues[0], creaseAt]);
  }

  const rim = [bl, ...[...left].reverse(), apex, ...right, br];

  return {
    shadow: {
      cx: x + baseR * 0.34,
      cy: y + baseR * 0.1,
      rx: baseR * 1.05,
      ry: baseR * 0.22,
    },
    body: polygonPath(rim),
    outline: openPath(rim),
    lit: polygonPath(litFace),
    shade: polygonPath(shadeFace),
    crease: `M ${apex.x.toFixed(2)} ${apex.y.toFixed(2)} L ${foot.x.toFixed(2)} ${foot.y.toFixed(2)}`,
    snow,
    snowShade,
    scree: peak.scree.map((s) => ({ cx: x + s.dx, cy: y + s.dy, r: s.r })),
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
