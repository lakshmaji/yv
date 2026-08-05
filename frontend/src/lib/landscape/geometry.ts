// Pure 2D helpers that turn point lists into SVG path strings. Kept separate
// from world.ts so the fiddly parts — closed-vs-open smoothing, polygon
// containment, insetting — are unit-testable on their own.

import type { Rng } from './rng';

export interface Pt {
  x: number;
  y: number;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Rounds to 2dp so path strings stay short and compare cleanly in tests. */
function r(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Catmull-Rom through every point, emitted as cubic beziers — the standard way
 * to get an organic coastline from a handful of control points without the
 * corners a polyline would show.
 *
 * `closed` wraps the neighbour lookup so the seam is as smooth as the rest of
 * the ring; open curves clamp to the endpoints instead.
 */
export function catmullRomPath(points: readonly Pt[], closed = false): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${r(points[0].x)} ${r(points[0].y)}`;
  if (points.length === 2) {
    return `M ${r(points[0].x)} ${r(points[0].y)} L ${r(points[1].x)} ${r(points[1].y)}`;
  }

  const n = points.length;
  const at = (i: number): Pt => {
    if (closed) return points[((i % n) + n) % n];
    return points[Math.min(n - 1, Math.max(0, i))];
  };

  const last = closed ? n - 1 : n - 2;
  let d = `M ${r(points[0].x)} ${r(points[0].y)}`;
  for (let i = 0; i <= last; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${r(c1x)} ${r(c1y)}, ${r(c2x)} ${r(c2y)}, ${r(p2.x)} ${r(p2.y)}`;
  }
  if (closed) d += ' Z';
  return d;
}

/** Straight-edged polygon, for the faceted rock shapes. */
export function polygonPath(points: readonly Pt[]): string {
  if (points.length === 0) return '';
  return (
    `M ${r(points[0].x)} ${r(points[0].y)}` +
    points.slice(1).map((p) => ` L ${r(p.x)} ${r(p.y)}`).join('') +
    ' Z'
  );
}

/**
 * A closed ring of `count` points around an ellipse, each radius scaled by a
 * smoothly-varying random factor. `amp` is the fraction of the radius the
 * wobble may consume, so 0.3 gives a clearly lumpy island and 0.05 a near-oval.
 *
 * The wobble is built from two low-frequency sine harmonics with seeded phases
 * rather than per-point noise: independent jitter per vertex reads as a jagged
 * star, whereas harmonics give the broad bays and headlands a coastline has.
 */
export function jitterRing(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  count: number,
  rng: Rng,
  amp = 0.22,
): Pt[] {
  const phase1 = rng.range(0, Math.PI * 2);
  const phase2 = rng.range(0, Math.PI * 2);
  const freq1 = rng.int(2, 4);
  const freq2 = rng.int(5, 8);
  const pts: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const wobble =
      1 +
      amp * 0.65 * Math.sin(a * freq1 + phase1) +
      amp * 0.35 * Math.sin(a * freq2 + phase2);
    pts.push({ x: cx + Math.cos(a) * rx * wobble, y: cy + Math.sin(a) * ry * wobble });
  }
  return pts;
}

/** Average of the points — good enough as a polygon centre for our shapes. */
export function centroid(points: readonly Pt[]): Pt {
  if (points.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

/**
 * Shrinks a polygon by pulling every vertex `amount` px toward the centroid.
 *
 * A true straight-skeleton offset is overkill here: these are convex-ish blobs
 * and the result only has to look like a terrace step stacked inside the one
 * below it.
 */
export function insetPolygon(points: readonly Pt[], amount: number): Pt[] {
  const c = centroid(points);
  return points.map((p) => {
    const d = dist(p, c);
    if (d === 0) return { x: p.x, y: p.y };
    const t = Math.max(0, (d - amount) / d);
    return { x: c.x + (p.x - c.x) * t, y: c.y + (p.y - c.y) * t };
  });
}

/** Even-odd ray cast. Points exactly on an edge are not guaranteed either way. */
export function pointInPolygon(p: Pt, polygon: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const straddles = a.y > p.y !== b.y > p.y;
    if (straddles && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Pulls `p` toward `anchor` until it lies inside `polygon`.
 *
 * This is the cheap stand-in for polygon clipping: biome blobs are generated
 * freely around their centroid and then each vertex is walked back inside the
 * coastline, so no biome ever spills into the sea. Bisection over the segment
 * is enough because the anchor is always inside and the shapes are convex-ish.
 */
export function clampInside(p: Pt, polygon: readonly Pt[], anchor: Pt, steps = 12): Pt {
  if (pointInPolygon(p, polygon)) return { x: p.x, y: p.y };
  let lo = 0; // known inside (the anchor)
  let hi = 1; // known outside (p)
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    const q = { x: lerp(anchor.x, p.x, mid), y: lerp(anchor.y, p.y, mid) };
    if (pointInPolygon(q, polygon)) lo = mid;
    else hi = mid;
  }
  return { x: lerp(anchor.x, p.x, lo), y: lerp(anchor.y, p.y, lo) };
}

/** Nearest of `points` to `p`, by index. -1 for an empty list. */
export function nearestIndex(p: Pt, points: readonly Pt[]): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = dist(p, points[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
