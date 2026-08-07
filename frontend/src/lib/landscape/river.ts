// Turns a river's centreline and per-point widths into the shapes that draw it.
//
// Kept out of Water.tsx for the same reason drone.ts is kept out of Drone.tsx: this
// is where the look is actually decided, and it can only be proved correct — banks
// that never fold, a channel that never draws wider than the world reserved for it —
// by a test that can call it without a DOM.
//
// Nothing here is written back into `River.points`. The generator's points are load
// bearing (a tributary's last point is by-value identical to a trunk vertex, and the
// scatter passes reserve clearance around each one), so the resampled centreline
// lives only here, at draw time.

import {
  catmullRomPath,
  catmullRomPoints,
  curvatures,
  dist,
  normal,
  resample,
  sampleScalar,
  tangents,
  type Pt,
} from './geometry';
import { makeRng, hashText } from './rng';
import { type River } from './world';

/** Spacing between centreline samples, in world px. */
export const RIVER_STEP = 9;

/**
 * Samples a course gets however short it is.
 *
 * A fixed step alone is not enough: the shortest tributary a seed can produce is a
 * couple of steps long, and three samples cannot carry a wobble, a shoal or a
 * streak — the ribbon degenerates into a triangle. Below this length the step
 * shrinks instead.
 */
export const MIN_SAMPLES = 12;

/**
 * How far the dark casing extends past each bank.
 *
 * Proportional, with a cap, rather than a flat number of pixels. The whole drawing
 * has to fit inside the clearance the generator reserved (`WATER_RESERVE` of the
 * river's widest point), and a fixed 2.5px casing around a 8px headwater stream
 * already breaks that budget where the same 2.5px around the estuary is nothing.
 */
export const BANK_PAD_FRACTION = 0.16;
export const BANK_PAD_MAX = 2.5;

export function bankPad(river: River): number {
  return Math.min(BANK_PAD_MAX, river.width * BANK_PAD_FRACTION);
}

/**
 * Per-bank wobble, as a fraction of the local half-width.
 *
 * This — not the downstream taper — is what makes the banks read as banks. A width
 * profile is symmetric, so tapering alone still leaves the two sides mirror images
 * of each other and the channel looks extruded. Each side gets its own harmonics
 * instead, the reasoning `jitterRing` uses for the coastline. Both sides stay above
 * `1 - AMP` of the half-width, so no wobble can pinch a reach shut.
 */
export const BANK_AMP = 0.2;

/**
 * Cap on the inner half-width of a bend, as a fraction of the radius of curvature.
 *
 * Below 1 by a wide margin for two reasons: the bank *points* are re-smoothed with
 * `catmullRomPath`, which bows outside the polyline it was fitted to exactly where
 * the turn is tightest, and the curvature itself is estimated from samples 9px apart,
 * which understates a corner sharper than that.
 */
export const MAX_CURVE_FILL = 0.55;

/** How far the lit shoal slides off the centreline, as a fraction of half-width. */
const SHOAL_SLIDE = 0.35;

/** Width of the shoal band, as a fraction of the channel. */
const SHOAL_FRACTION = 0.4;

/**
 * The map's light, normalised. Top-left, matching `terrain-shadow`'s dx/dy and every
 * `*Light`/`*Dark` pair in the palette.
 */
const LIGHT: Pt = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };

/**
 * Threads: the long lines that run the length of the channel.
 *
 * Short marks alone do not make a stream. Scattered stubs read as flecks *on* water,
 * and what says "this is flowing" is a set of streamlines running the whole reach,
 * following the banks in and out — the long sweeping lines the reference drawing is
 * mostly made of. So the channel is laid out lengthwise first and textured second.
 *
 * One thread per this much of the channel's width, so a wide estuary carries several
 * and a headwater brook carries one.
 */
const THREAD_PER_WIDTH = 7;
const MAX_THREADS = 6;

/** Fraction of the course a thread spans, before the ends are jittered in. */
const THREAD_SPAN = 0.72;

/** How far a thread wanders across the channel over its length. */
const THREAD_WANDER = 0.34;

/**
 * How densely ripples are laid along a course, and the ceiling on one river.
 *
 * These are the texture over the threads: current is not perfectly laminar, and a
 * channel of nothing but parallel lines reads as combed hair.
 */
const STREAK_PER_SAMPLE = 0.16;
const MAX_STREAKS = 16;

/**
 * How fast the current runs, in px of the world's 1600×900 space per second.
 *
 * A streak's duration is derived from this and the distance it actually travels,
 * rather than being drawn independently: picking the two separately let a long
 * river end up with slow water and a short one with fast, when the thing that
 * should be shared across a map is the *speed*. Everything else about a streak
 * is jittered; this is the one quantity that wants to agree.
 */
const FLOW_SPEED = 13;

export interface Banks {
  /** Arc-length-uniform samples of the smoothed centreline. */
  center: Pt[];
  /** Unit flow direction at each sample. */
  tangent: Pt[];
  /** Symmetric half-width at each sample, before the per-side wobble. */
  half: number[];
  left: Pt[];
  right: Pt[];
  /** Normalised arc length at each sample, 0 at the source and 1 at the mouth. */
  s: number[];
  length: number;
}

export interface Streak {
  /**
   * `thread` runs the length of the channel and carries its motion as light
   * travelling *along* the line; `ripple` is a short mark that drifts bodily
   * downstream and fades.
   *
   * They cannot share one animation. A rigid translate is only downstream for a mark
   * short enough to be locally straight — applied to a thread that follows a bend, it
   * would push half the line out through the bank.
   */
  kind: 'thread' | 'ripple';
  d: string;
  width: number;
  opacity: number;
  dur: number;
  /** Negative, so the water is already in motion on the first frame. */
  delay: number;
  /** Ripples: downstream drift in world px, animated as a translate. */
  dx: number;
  dy: number;
  /** Threads: dash pattern and the offset it marches to, along the line. */
  dash: string;
  travel: number;
}

export interface RiverRibbon {
  /** Dark casing, a little wider than the channel: the cut bank. */
  bank: string;
  /** The channel itself. */
  body: string;
  /** Lit shallow edge, sliding from bank to bank as the course turns. */
  shoal: string;
  streaks: Streak[];
  /** Straight-stroke fallback for a course too short to make a ribbon from. */
  fallback: { d: string; width: number } | null;
}

/**
 * A stable seed from the river's own geometry, the trick `burstShards` uses.
 *
 * Every river's first point is unique within a world — the trunk starts at a biome
 * centre, each tributary at its own clamped scatter — so nothing has to be threaded
 * down from `generateWorld`, and `Math.random()` stays out of the map entirely.
 */
export function riverSeed(river: River): number {
  const p = river.points[0] ?? { x: 0, y: 0 };
  return hashText(
    `river:${river.points.length}:${river.width.toFixed(3)}:${p.x.toFixed(2)}:${p.y.toFixed(2)}`,
  );
}

/** Two low-frequency harmonics in normalised arc length, as a multiplier near 1. */
function wobbler(seed: ReturnType<typeof makeRng>): (s: number) => number {
  const phase1 = seed.range(0, Math.PI * 2);
  const phase2 = seed.range(0, Math.PI * 2);
  const freq1 = seed.range(1.2, 2.2) * Math.PI * 2;
  const freq2 = seed.range(3, 5) * Math.PI * 2;
  return (s) =>
    1 + BANK_AMP * (0.62 * Math.sin(s * freq1 + phase1) + 0.38 * Math.sin(s * freq2 + phase2));
}

/**
 * Resamples the smoothed centreline and offsets a bank to either side of it.
 *
 * A tributary has three control points, which cannot make a smooth ribbon on their
 * own — hence sampling the curve rather than the polyline, and hence this being the
 * one place the two are allowed to differ.
 */
export function riverBanks(river: River, seed: number): Banks {
  const curve = catmullRomPoints(river.points, 10, false);
  let course = 0;
  for (let i = 1; i < curve.length; i++) course += dist(curve[i - 1], curve[i]);
  const step = Math.min(RIVER_STEP, Math.max(0.5, course / MIN_SAMPLES));
  const sampled = resample(curve, step);

  const center = sampled.map((s) => s.p);
  const tangent = tangents(center);
  // `at` indexes the smoothed curve; scale it back onto the control points the
  // widths are attached to.
  const perPoint = Math.max(1, curve.length - 1) / Math.max(1, river.points.length - 1);
  const half = sampled.map((s) => sampleScalar(river.widths, s.at / perPoint) / 2);

  const steps = center.length;
  const arc: number[] = [0];
  for (let i = 1; i < steps; i++) arc.push(arc[i - 1] + dist(center[i - 1], center[i]));
  const length = arc[steps - 1] || 1;
  const s = arc.map((a) => a / length);

  const rng = makeRng(seed);
  const leftWobble = wobbler(rng);
  const rightWobble = wobbler(rng);
  const curve2 = curvatures(center);

  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < steps; i++) {
    const n = normal(tangent[i]);
    // The sharpest bend within a sample of here, not the bend exactly here. A
    // corner reads as curvature spread across three samples, and clamping only at
    // the one that happens to peak leaves its neighbours free to fold instead.
    let worst = 0;
    for (let k = Math.max(0, i - 1); k <= Math.min(steps - 1, i + 1); k++) {
      worst = Math.max(worst, Math.abs(curve2[k]));
    }
    // Applied to both banks, not just the inner one. Only the inside of a bend can
    // fold, but which side that is flips with the sign of a quantity estimated from
    // three samples — near an inflection the sign is exactly what is least reliable.
    const cap = worst === 0 ? Infinity : MAX_CURVE_FILL / worst;
    const lh = Math.min(half[i] * leftWobble(s[i]), cap);
    const rh = Math.min(half[i] * rightWobble(s[i]), cap);
    left.push({ x: center[i].x + n.x * lh, y: center[i].y + n.y * lh });
    right.push({ x: center[i].x - n.x * rh, y: center[i].y - n.y * rh });
  }

  return { center, tangent, half, left, right, s, length };
}

/** Closed outline enclosing both banks, optionally pushed out by `pad`. */
function ribbonPath(banks: Banks, pad = 0): string {
  const { center, tangent, left, right } = banks;
  const push = (p: Pt, c: Pt): Pt => {
    if (pad === 0) return p;
    const d = Math.hypot(p.x - c.x, p.y - c.y) || 1;
    return { x: p.x + ((p.x - c.x) / d) * pad, y: p.y + ((p.y - c.y) / d) * pad };
  };
  const l = left.map((p, i) => push(p, center[i]));
  const rev = right.map((p, i) => push(p, center[i])).reverse();
  // Axial points past each end. Without them the casing is only wider than the
  // channel sideways, so the two shapes share their end caps exactly and the casing
  // stops enclosing what it is supposed to be the bank of. The source end reaches
  // further, so a headwater tapers to a nose rather than ending in a flat wall; the
  // mouth stays nearly blunt, because a delta is blunt.
  const last = center.length - 1;
  const nose: Pt = {
    x: center[0].x - tangent[0].x * (banks.half[0] + pad) * 0.6,
    y: center[0].y - tangent[0].y * (banks.half[0] + pad) * 0.6,
  };
  const tail: Pt = {
    x: center[last].x + tangent[last].x * pad * 0.6,
    y: center[last].y + tangent[last].y * pad * 0.6,
  };
  return catmullRomPath([...l, tail, ...rev, nose], true);
}

/**
 * How far off the centreline a sample may reach on one side and still be in water.
 *
 * Measured against the bank that was actually drawn, not the nominal half-width: the
 * curvature clamp can pull a bank well inside `half` at a tight bend, and anything
 * placed inside the channel — the shoal, a flow streak — has to follow it in or it
 * spills onto the grass.
 */
function inset(banks: Banks, i: number, towardLeft: boolean, keep: number): number {
  const bank = towardLeft ? banks.left[i] : banks.right[i];
  return dist(banks.center[i], bank) * keep;
}

/**
 * The lit shallow edge.
 *
 * Slides across the channel with `dot(normal, LIGHT)` rather than sitting
 * concentrically inside it: a narrower band on the same centreline is exactly the
 * stroke this whole change replaced, and concentric bands are what make water read
 * as a pipe. Sliding, it hugs whichever bank is facing the light and fades out
 * where the course runs along it.
 */
export function shoalPath(banks: Banks): string {
  const { center, tangent, half } = banks;
  const upper: Pt[] = [];
  const lower: Pt[] = [];
  // Stops one sample short at each end. Reaching the very last sample would put the
  // band's own end cap on top of the channel's, and a shallow edge running right out
  // into the estuary is wrong anyway — that is where the water is deepest.
  for (let i = 1; i < center.length - 1; i++) {
    const n = normal(tangent[i]);
    const lit = n.x * LIGHT.x + n.y * LIGHT.y;
    const slide = half[i] * SHOAL_SLIDE * lit;
    const w = half[i] * SHOAL_FRACTION;
    const hi = Math.min(slide + w, inset(banks, i, true, 0.86));
    const lo = Math.max(slide - w, -inset(banks, i, false, 0.86));
    upper.push({ x: center[i].x + n.x * hi, y: center[i].y + n.y * hi });
    lower.push({ x: center[i].x + n.x * lo, y: center[i].y + n.y * lo });
  }
  return catmullRomPath([...upper, ...lower.reverse()], true);
}

/**
 * Streamlines running the length of the channel.
 *
 * This is what makes the water a stream rather than a line with marks on it. Each
 * thread is laid at its own depth across the channel and wanders slowly between
 * depths over its length, so the set of them describes water moving *through* a
 * shape instead of decorating one.
 *
 * The motion is light travelling along the line, not the line moving. That is the
 * one honest reading of a dash offset — it was wrong for the centreline this replaced
 * because there was a single dash down the middle of a uniform pipe, which is a road
 * marking; several at different depths and speeds inside an organic channel is
 * current.
 */
function flowThreads(banks: Banks, rng: ReturnType<typeof makeRng>): Streak[] {
  const { center, tangent, half, length } = banks;
  const widest = Math.max(...half) * 2;
  const count = Math.max(1, Math.min(MAX_THREADS, Math.round(widest / THREAD_PER_WIDTH)));
  const threads: Streak[] = [];

  for (let k = 0; k < count; k++) {
    // Depths spread across the channel rather than drawn independently: random
    // offsets clump, and two threads on top of each other read as one heavy line.
    const lane = count === 1 ? 0 : (k / (count - 1)) * 2 - 1;
    const depth = lane * 0.6 + rng.range(-0.12, 0.12);
    const wanderPhase = rng.range(0, Math.PI * 2);
    const wanderFreq = rng.range(1.1, 2.4) * Math.PI * 2;

    const span = Math.round(center.length * THREAD_SPAN * rng.range(0.85, 1));
    const first = Math.max(1, rng.int(1, Math.max(1, center.length - span - 2)));
    const last = Math.min(center.length - 2, first + span);
    if (last - first < 3) continue;

    const pts: Pt[] = [];
    for (let i = first; i <= last; i++) {
      const n = normal(tangent[i]);
      const u = (i - first) / (last - first);
      // Fades in and out at the ends, so a thread emerges from the water rather
      // than starting at a hard tip.
      const ends = Math.min(1, Math.sin(u * Math.PI) * 2.2);
      const wander = 1 + THREAD_WANDER * Math.sin(banks.s[i] * wanderFreq + wanderPhase);
      const want = half[i] * depth * wander * ends;
      const limit = inset(banks, i, want > 0, 0.74);
      const off = Math.sign(want) * Math.min(Math.abs(want), limit);
      pts.push({ x: center[i].x + n.x * off, y: center[i].y + n.y * off });
    }
    if (pts.length < 3) continue;

    // One dash and a long gap, so what travels is a glint rather than a chain of
    // ticks. Sized off the reach the thread covers, not a constant, or a short
    // tributary gets a dash longer than itself.
    const reach = (length * (last - first)) / Math.max(1, center.length - 1);
    const dash = Math.max(14, reach * 0.22);
    const gap = dash * rng.range(1.6, 2.6);
    threads.push({
      kind: 'thread',
      d: catmullRomPath(pts, false),
      width: Math.max(1.1, half[first] * rng.range(0.1, 0.18)),
      opacity: rng.range(0.16, 0.32),
      dur: (dash + gap) / (FLOW_SPEED * rng.range(0.85, 1.2)),
      delay: -rng.range(0, 12),
      dx: 0,
      dy: 0,
      dash: `${dash.toFixed(1)} ${gap.toFixed(1)}`,
      // Negative: dashoffset decreasing walks the dash forward along the path, which
      // is drawn source-to-mouth, so the glint runs downstream.
      travel: -(dash + gap),
    });
  }
  return threads;
}

/**
 * Short curved marks over the threads, drifting bodily downstream and fading.
 *
 * The threads alone are laminar, and a channel of nothing but parallel lines reads as
 * combed hair. These break it up, and they are the layer that visibly *moves* —
 * travel along a line is subtle, whereas a mark crossing the water is not.
 *
 * Every mark is held well inside the banks, so none can spill onto land as the course
 * turns.
 */
function flowRipples(banks: Banks, rng: ReturnType<typeof makeRng>): Streak[] {
  const { center, tangent, half } = banks;
  const count = Math.min(MAX_STREAKS, Math.floor(center.length * STREAK_PER_SAMPLE));
  const streaks: Streak[] = [];

  for (let k = 0; k < count; k++) {
    const span = Math.max(2, Math.round(rng.range(3, 6)));
    // Never starts on the first sample or ends on the last: a streak sharing an end
    // cap with the channel sits on the outline rather than inside it, and one jammed
    // into the source looks like a crack rather than current.
    const start = rng.int(1, Math.max(1, center.length - span - 2));
    if (start + span > center.length - 2) continue;
    const offset = rng.range(-0.62, 0.62);
    const pts: Pt[] = [];
    for (let i = start; i <= start + span; i++) {
      const n = normal(tangent[i]);
      // The lateral offset eases off at both tips, so a streak is a leaf rather
      // than a parallel rule beside the bank.
      const u = (i - start) / span;
      const taper = Math.sin(u * Math.PI) * 0.35 + 0.65;
      const want = half[i] * offset * taper;
      const limit = inset(banks, i, want > 0, 0.72);
      const off = Math.sign(want) * Math.min(Math.abs(want), limit);
      pts.push({ x: center[i].x + n.x * off, y: center[i].y + n.y * off });
    }
    if (pts.length < 3) continue;

    const t = tangent[Math.min(center.length - 1, start + Math.floor(span / 2))];
    // Far enough to be read as travel. At the 12–20px this started at, a streak
    // crossed about its own length over the whole cycle, which the eye takes as
    // a shimmer in place rather than as water going somewhere.
    const drift = rng.range(40, 64);
    streaks.push({
      kind: 'ripple',
      d: catmullRomPath(pts, false),
      width: Math.max(1.6, half[start] * rng.range(0.2, 0.34)),
      opacity: rng.range(0.34, 0.66),
      dx: t.x * drift,
      dy: t.y * drift,
      dur: drift / (FLOW_SPEED * rng.range(0.82, 1.24)),
      delay: -rng.range(0, 9),
      dash: '',
      travel: 0,
    });
  }
  return streaks;
}

/**
 * The channel's whole interior: streamlines along it, then ripples over them.
 *
 * Both share one rng so the pair is a single seeded drawing — a river's threads and
 * its ripples belong to the same water.
 */
export function flowStreaks(banks: Banks, seed: number): Streak[] {
  const rng = makeRng(seed ^ 0x5f3a91);
  return [...flowThreads(banks, rng), ...flowRipples(banks, rng)];
}

/** Everything Water.tsx needs for one river. */
export function riverRibbon(river: River): RiverRibbon {
  const empty: RiverRibbon = { bank: '', body: '', shoal: '', streaks: [], fallback: null };
  if (river.points.length < 3 || river.widths.length !== river.points.length) {
    return {
      ...empty,
      fallback: {
        d: catmullRomPath(river.points, false),
        width: Math.max(1, river.width),
      },
    };
  }

  const banks = riverBanks(river, riverSeed(river));
  if (banks.center.length < 3 || banks.length === 0) {
    return {
      ...empty,
      fallback: { d: catmullRomPath(river.points, false), width: Math.max(1, river.width) },
    };
  }

  return {
    bank: ribbonPath(banks, bankPad(river)),
    body: ribbonPath(banks),
    shoal: shoalPath(banks),
    streaks: flowStreaks(banks, riverSeed(river)),
    fallback: null,
  };
}

/**
 * The widest the casing gets, as a multiple of the reserved clearance radius.
 *
 * Exposed for the test that proves a drawn river never exceeds the obstacle the
 * scatter passes reserved for it — i.e. that no tree ends up standing in water.
 */
export function widestDrawn(river: River, banks: Banks): number {
  const pad = bankPad(river);
  let widest = 0;
  for (let i = 0; i < banks.center.length; i++) {
    widest = Math.max(
      widest,
      dist(banks.center[i], banks.left[i]) + pad,
      dist(banks.center[i], banks.right[i]) + pad,
    );
  }
  return widest;
}
