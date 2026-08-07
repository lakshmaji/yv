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

import { catmullRomPath, centroid, type Pt } from './geometry';
import { makeRng, type Rng } from './rng';

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
