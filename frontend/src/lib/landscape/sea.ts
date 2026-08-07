// Swell rolling in against the shore, drawn as a few rings standing off the coast.
//
// The sea already had two cues before this: three blurred ellipses drifting around
// the open water, and a single foam line traced on the coastline itself. Neither
// says which way the water is going. The ellipses move, but they are so diffuse and
// so slow that they read as light on the surface rather than as swell; the foam line
// only pulses in place, so the shore looks lit rather than washed.
//
// What was missing is travel *towards* the land. These rings supply it: each one is
// the coastline pushed offshore, and it contracts back onto the coast while fading,
// so the eye follows a band of water in and loses it at the moment it breaks. Several
// rings at staggered phases make it continuous rather than a single pulse.
//
// Nothing here is written back into the world. `generateWorld` is seeded and its
// output is asserted on all over world.test.ts; the swell is presentation derived
// from the coast, the same arrangement river.ts has with River.

import { catmullRomPath, centroid, pointInPolygon, type Pt } from './geometry';
import { makeRng, type Rng } from './rng';
import { ringPath } from './world';

/**
 * How far offshore the outermost ring starts, in world px.
 *
 * Bounded by the shelf: `LandscapeMap` draws a 70px-wide blurred band along the
 * coast for the shallows, and swell that begins outside it appears to arrive from
 * the abyss with nothing shoaling it.
 */
export const SWELL_REACH = 64;

/** Closest a ring gets before it is treated as broken and faded out. */
const SWELL_MIN = 6;

/** How many bands of swell are in the water at once. */
export const SWELL_RINGS = 4;

/** One full run from offshore to the beach, in seconds, before jitter. */
const SWELL_PERIOD = 7.5;

/**
 * How much a ring's offshore distance varies along the shore, as a fraction of it.
 *
 * The reason this exists at all: a ring offset by one constant distance is the
 * coastline scaled, so a stack of them is a contour map — perfectly nested curves all
 * exactly parallel to the shore and to each other. That is the "line around the
 * island" reading, and no amount of tuning opacity or width fixes it, because the
 * problem is that the shapes are similar. Each ring gets its own harmonics, so no two
 * are parallel and none is parallel to the coast.
 */
const SWELL_WOBBLE = 0.6;

/**
 * How far along the shore the pattern shifts from one ring to the next, in radians.
 *
 * The rings share their harmonics and differ only by this shift, rather than each
 * drawing its own. Independent shapes cross each other, which reads as scribble;
 * one shape advancing along the shore reads as a wave train, which is what a swell
 * is. Small, so consecutive bands stay clear of one another.
 */
const SWELL_MARCH = 0.4;

/**
 * How far the lee side is suppressed, as a fraction of the windward reach.
 *
 * Swell arrives from a direction. Standing an equal band off every side of an island
 * says the water is closing in from everywhere at once, which is what a ripple in a
 * pond does, not what a sea does. Shores facing the swell get the full reach; shores
 * in the lee keep only this much, so the bands crowd on one flank and thin out around
 * the back.
 */
const LEE_FLOOR = 0.28;

/**
 * Length of one crest and of the gap after it, in coast vertices.
 *
 * A wave is not a line drawn all the way round an island. A closed ring reads as a
 * racetrack marking however irregular its shape is, because an unbroken curve returning
 * to its own start is a boundary, not a crest — the eye follows it round rather than
 * across. Real swell shows as broken arcs: a crest rises over some stretch of shore,
 * dies, and another picks up further along.
 *
 * The coast has 46 vertices, so these give roughly four to six crests to a ring.
 */
const CREST_MIN = 5;
const CREST_MAX = 11;
const GAP_MIN = 2;
const GAP_MAX = 6;

/**
 * Below this exposure a stretch of shore carries no crest at all.
 *
 * The lee is already drawn closer in by `LEE_FLOOR`, but distance alone still says
 * "wave, further away". Dropping the arc says there is no wave there, which is what
 * being sheltered means.
 */
const CREST_EXPOSURE = 0.46;

/** One broken crest of a wave. */
export interface Arc {
  d: string;
  strokeWidth: number;
  opacity: number;
}

export interface Wave {
  /**
   * The crests this wave is broken into, each an open arc. Several rather than one
   * closed ring, and never a `Z` — see `CREST_MIN`.
   */
  arcs: Arc[];
  /** Nominal offshore distance for this ring — its station in the sequence. */
  offset: number;
  /**
   * Mean distance the ring actually stands off the coast, once the wobble and the lee
   * have moved it. `to` is derived from this and not from `offset`, so a ring lands on
   * the break line it is really aimed at.
   */
  reach: number;
  /**
   * Scale the ring contracts to, about the island's centroid. Below 1: the ring
   * is drawn at its offshore position and shrinks onto the shore from there.
   */
  to: number;
  strokeWidth: number;
  opacity: number;
  dur: number;
  /** Negative, so a ring is already part-way in on the first frame. */
  delay: number;
}

export interface Swell {
  /** Centroid of the coast — the origin every ring contracts about. */
  origin: Pt;
  waves: Wave[];
}

/* ---------------------------------------------------------------------------- *
 * Surf and whitecaps.
 *
 * The swell above answers "which way is the water going". These two answer "is
 * this water at all", at the shore and out on the open sea.
 *
 * There was a third — broad flat tone patches under everything, standing in for
 * the paper-cut reference's surface. They went when the sea got animals in it:
 * texture and a subject were doing the same job, and a whale does it better than
 * a blob does.
 * ---------------------------------------------------------------------------- */

/** How far the white collar of surf reaches out from the shore, in world px. */
export const SURF_REACH = 18;

/**
 * Scallop count and depth for the surf collar.
 *
 * Surf is not a stroke of even width. It piles up in lobes — deeper where the water
 * shoals, pinched almost to nothing between — and that scalloped inner edge is the
 * single strongest cue in the reference. A constant-width ring in white would just be
 * a bright outline, which is a sticker, not spray.
 */
const SURF_LOBES = 8;
const SURF_PINCH = 0.62;

/** One whitecap per this much sea area, and the ceiling on the whole map. */
const CAP_PER_AREA = 34_000;
export const MAX_WHITECAPS = 46;

/** How far out from the coast a whitecap may sit before it is dropped. */
const CAP_MAX_OFFSHORE = 260;

/** The white collar of broken water hugging the shore. */
export interface Surf {
  /** Filled band between the shoreline and the scalloped outer edge of the spray. */
  d: string;
  opacity: number;
}

/** A whitecap out on open water: a short stroke, twinkling in and out. */
export interface Whitecap {
  d: string;
  strokeWidth: number;
  opacity: number;
  dur: number;
  delay: number;
}

/**
 * Cuts one ring of offshore points into separate crests.
 *
 * The cut positions are drawn per ring rather than shared, which is the opposite of
 * what the *shape* harmonics do — and deliberately so. The shape has to be shared or
 * the rings cross; the gaps have to differ or they line up radially and punch a visible
 * corridor straight through the swell.
 *
 * A crest is dropped where its shore is sheltered, so the lee has no arcs rather than
 * fainter ones. Each surviving crest is jittered off the ring's base width and opacity,
 * because four crests at identical weight read as one dashed line — the very thing this
 * is here to avoid.
 */
function breakIntoCrests(
  points: readonly Pt[],
  shore: readonly { face: number }[],
  rng: Rng,
  width: number,
  alpha: number,
): Arc[] {
  const n = points.length;
  const arcs: Arc[] = [];
  if (n < 4) return arcs;

  // Start at a random vertex so a ring's first crest does not always begin at the
  // same bearing, which would line the seams up across the whole swell.
  let i = rng.int(0, n - 1);
  let walked = 0;

  while (walked < n) {
    const span = Math.min(rng.int(CREST_MIN, CREST_MAX), n - walked);
    const run: Pt[] = [];
    let exposure = 0;
    for (let k = 0; k < span; k++) {
      const at = (i + k) % n;
      run.push(points[at]);
      exposure += shore[at].face * 0.5 + 0.5;
    }
    exposure /= span;

    if (run.length >= 3 && exposure >= CREST_EXPOSURE) {
      arcs.push({
        // Open, never closed: a crest has two ends.
        d: catmullRomPath(run, false),
        strokeWidth: width * rng.range(0.72, 1.15),
        opacity: Math.min(1, alpha * rng.range(0.8, 1.15)),
      });
    }

    const gap = rng.int(GAP_MIN, GAP_MAX);
    i = (i + span + gap) % n;
    walked += span + gap;
  }

  return arcs;
}

/**
 * Rings of swell standing off `coast`, ordered outermost first.
 *
 * Seeded, so a given island always has the same swell: the map is regenerated from
 * a visible seed and a sea that reshuffled on every render would be the one part of
 * it that could not be reproduced from that number.
 *
 * The contraction is a scale about the centroid rather than an animation between two
 * offset rings, because SVG cannot tween one path into another without a matching
 * point count, and `insetPolygon` is itself radial from that same centroid — so the
 * scale reproduces exactly the offsets between the rings it sits between. A perfectly
 * uniform offshore distance would need a straight-skeleton offset, which is far more
 * machinery than a blob-shaped island repays.
 */
export function coastalSwell(coast: readonly Pt[], seed: number): Swell {
  const origin = centroid(coast);
  if (coast.length < 3) return { origin, waves: [] };

  // Mean radius is what turns an absolute offshore distance into the scale factor
  // that reaches it, since insetPolygon moves every vertex radially from `origin`.
  let radius = 0;
  for (const p of coast) radius += Math.hypot(p.x - origin.x, p.y - origin.y);
  radius = radius / coast.length;
  if (radius <= 0) return { origin, waves: [] };

  const rng = makeRng(seed ^ 0x2b91d7);

  // Where the swell comes from. One direction for the whole island, so every ring
  // crowds the same flank and the sea has a weather side.
  const from = rng.range(0, Math.PI * 2);
  const swell: Pt = { x: Math.cos(from), y: Math.sin(from) };

  // Outward direction and bearing per coast vertex, computed once.
  const shore = coast.map((p) => {
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    const len = Math.hypot(dx, dy) || 1;
    const dir = { x: dx / len, y: dy / len };
    return { p, dir, angle: Math.atan2(dy, dx), face: dir.x * swell.x + dir.y * swell.y };
  });

  // Two low-frequency harmonics in the bearing around the island — the same
  // construction `jitterRing` uses for the coastline itself, and for the same reason:
  // per-vertex noise reads as a jagged star, harmonics as long swells. Drawn once and
  // shared by every ring, which is what makes the set a train rather than a scribble.
  const p1 = rng.range(0, Math.PI * 2);
  const p2 = rng.range(0, Math.PI * 2);
  const f1 = rng.int(2, 3);
  const f2 = rng.int(4, 6);

  const waves: Wave[] = [];

  for (let k = 0; k < SWELL_RINGS; k++) {
    // Evenly spaced in phase, not in distance: the rings are stations of one
    // travelling band, so what has to be uniform is the gap in time between them.
    const phase = k / SWELL_RINGS;
    const offset = SWELL_MIN + (SWELL_REACH - SWELL_MIN) * (1 - phase);
    const march = SWELL_MARCH * k;
    // Waves refract as they shoal: by the time one is breaking it has swung round to
    // lie along the beach, whatever shape it had out at sea. So the wobble is scaled
    // by how far offshore this ring is — the outermost is the irregular one, and the
    // innermost is nearly parallel to the shore, which is also why the bands never
    // pile into each other at the point where they are closest together.
    const amp = SWELL_WOBBLE * (offset / SWELL_REACH);

    let meanReach = 0;
    const points = shore.map(({ p, dir, angle, face }) => {
      const wobble =
        1 +
        amp *
          (0.62 * Math.sin(angle * f1 + p1 + march) + 0.38 * Math.sin(angle * f2 + p2 + march));
      // `face` is +1 dead into the swell and -1 in the lee; remapped to [LEE_FLOOR, 1].
      const exposure = LEE_FLOOR + (1 - LEE_FLOOR) * (face * 0.5 + 0.5);
      const reach = Math.max(SWELL_MIN, offset * wobble * exposure);
      meanReach += reach;
      return { x: p.x + dir.x * reach, y: p.y + dir.y * reach };
    });
    meanReach /= shore.length;

    const width = 2.4 + 2.6 * (offset / SWELL_REACH);
    // Weight per crest. Higher than it looks like it should be because the animation
    // owns the wave's own opacity — `land-wave-break` fades the whole group 0 → 1 → 0,
    // and a crest's value multiplies with that rather than competing with it. While the
    // wave was one path the keyframe simply overrode the attribute, so the number here
    // had no effect at all.
    const alpha = 0.5 + 0.35 * (1 - offset / SWELL_REACH);

    waves.push({
      arcs: breakIntoCrests(points, shore, rng, width, alpha),
      offset,
      reach: meanReach,
      // Derived from this ring's own mean reach rather than the nominal offset, since
      // the wobble and the lee have moved it.
      to: (radius + SWELL_MIN) / (radius + meanReach),
      // Thicker further out and fainter as it breaks, so the band reads as one
      // wave losing itself on the shore rather than four separate rings.
      strokeWidth: width,
      opacity: alpha,
      dur: SWELL_PERIOD * rng.range(0.92, 1.1),
      // Spread over one period so the rings arrive in sequence. Negative, so the
      // sea is mid-swell on the first frame instead of starting from flat calm.
      delay: -SWELL_PERIOD * phase,
    });
  }

  return { origin, waves };
}

/**
 * The white collar of broken water around the shore.
 *
 * A filled band rather than a stroke, because the two edges do different things: the
 * inner one is the shoreline exactly, and the outer one scallops in and out. That
 * difference is what makes it spray. A stroke can only ever be the shoreline offset by
 * one number, which is the same defect the swell rings had.
 *
 * Seeded from the coast's own bearing so the lobes sit in the same places every time
 * this island is drawn.
 */
export function coastalSurf(coast: readonly Pt[], seed: number): Surf | null {
  if (coast.length < 3) return null;
  const origin = centroid(coast);
  const rng = makeRng(seed ^ 0x71c5a3);
  const phase = rng.range(0, Math.PI * 2);
  const freq = SURF_LOBES + rng.int(0, 2);

  const outer = coast.map((p) => {
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    const len = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx);
    // Never fully pinched off: a gap in the collar reads as a hole in the island.
    const lobe = 1 - SURF_PINCH * (0.5 + 0.5 * Math.cos(angle * freq + phase));
    const reach = SURF_REACH * Math.max(0.18, lobe);
    return { x: p.x + (dx / len) * reach, y: p.y + (dy / len) * reach };
  });

  // Outer ring forwards, shoreline backwards: an annulus in one subpath, so it fills
  // as a band without needing a fill-rule or a second element to punch the hole.
  return {
    d: `${ringPath(outer)} ${ringPath([...coast].reverse())}`,
    opacity: 0.72,
  };
}

/**
 * Short white strokes scattered over the open sea.
 *
 * These are what stop the water between the island and the frame reading as empty
 * space. Rejection sampling against the coast and the islets rather than a computed
 * safe region: the shapes are blobs, the predicate is one call, and a rejected sample
 * costs nothing.
 *
 * Held within `CAP_MAX_OFFSHORE` of the shore as well as outside it, so the caps
 * describe water *around the island* rather than an even confetti over the frame —
 * the far corners of the reference are open water with nothing on them.
 */
export function whitecaps(
  coast: readonly Pt[],
  islets: readonly Pt[][],
  width: number,
  height: number,
  seed: number,
): Whitecap[] {
  if (coast.length < 3) return [];
  const rng = makeRng(seed ^ 0x3d90f1);
  const want = Math.min(MAX_WHITECAPS, Math.round((width * height) / CAP_PER_AREA));
  const middle = centroid(coast);
  const caps: Whitecap[] = [];

  // A fixed budget of attempts, not "until we have enough": a small island in a big
  // frame would otherwise be fine, but a large one leaves little open water and the
  // loop would spin.
  for (let attempt = 0; attempt < want * 12 && caps.length < want; attempt++) {
    const p = { x: rng.range(20, width - 20), y: rng.range(20, height - 20) };
    if (pointInPolygon(p, coast)) continue;
    if (islets.some((ring) => pointInPolygon(p, ring))) continue;

    // Distance to the nearest shore vertex is a good enough stand-in for distance to
    // the coastline: the vertices are 46 around the ring, far denser than this bound.
    let near = Infinity;
    for (const c of coast) near = Math.min(near, Math.hypot(p.x - c.x, p.y - c.y));
    if (near > CAP_MAX_OFFSHORE) continue;

    // Lying along the swell, roughly: caps that all point the same way read as hatching,
    // caps at random angles read as scratches. A shared bearing with jitter reads as sea.
    const lie = Math.atan2(p.y - middle.y, p.x - middle.x) + Math.PI / 2;
    const angle = lie + rng.range(-0.5, 0.5);
    // Short, thick and visibly bowed. Long thin near-straight marks read as scratches
    // on the picture rather than as water: what makes a whitecap is that it is a
    // chunky little crest with a curve to it, so the length came down and the bow and
    // the weight went up.
    const half = rng.range(10, 19);
    // A shallow crescent. Bowed as hard as it is long turns a crest into a hook, which
    // reads as a bracket or a small animal rather than as water.
    const bow = rng.range(2.4, 4.8) * (rng.chance(0.5) ? 1 : -1);
    const nx = -Math.sin(angle);
    const ny = Math.cos(angle);
    const a = { x: p.x - Math.cos(angle) * half, y: p.y - Math.sin(angle) * half };
    const b = { x: p.x + nx * bow, y: p.y + ny * bow };
    const c = { x: p.x + Math.cos(angle) * half, y: p.y + Math.sin(angle) * half };

    // The *cap* has to be at sea, not just the point it was grown from. A cap is up to
    // 22px long either way, so a centre that clears the shore by less than that still
    // puts an end of the stroke on the grass — which is not a wave, it is a scratch on
    // the island. Testing the drawn ends is exact, where a margin on `near` would not
    // be: nearest-vertex distance overstates the distance to the coastline between
    // vertices, and the shape is a blob, so there is no radius that is safe everywhere.
    if ([a, b, c].some((q) => pointInPolygon(q, coast))) continue;
    if (islets.some((ring) => [a, b, c].some((q) => pointInPolygon(q, ring)))) continue;

    caps.push({
      d: catmullRomPath([a, b, c], false),
      strokeWidth: rng.range(3, 5.6),
      opacity: rng.range(0.34, 0.7),
      dur: rng.range(4, 9),
      // Negative and spread wide, so they are not all bright on the first frame.
      delay: -rng.range(0, 9),
    });
  }
  return caps;
}
