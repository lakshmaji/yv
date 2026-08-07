import { describe, expect, it } from 'vitest';
import { centroid, type Pt } from './geometry';
import {
  MAX_WHITECAPS,
  SEA_PATCHES,
  SURF_REACH,
  SWELL_REACH,
  SWELL_RINGS,
  coastalSurf,
  coastalSwell,
  seaPatches,
  whitecaps,
} from './sea';
import { WORLD_H, WORLD_W, generateWorld } from './world';
import { pointInPolygon } from './geometry';

const SEEDS = [1, 7, 20260806, 88123, 999999];

/**
 * On-curve points of a ring path: the moveto, then the endpoint of each cubic.
 *
 * The bezier control points are skipped deliberately — they sit off the curve by
 * design, so a ring drawn perfectly outside the coast would still fail a
 * containment check that counted them. Same helper river.test.ts uses.
 */
function onCurvePoints(d: string): Pt[] {
  const pts: Pt[] = [];
  const move = d.match(/^M\s+(-?[\d.]+)\s+(-?[\d.]+)/);
  if (move) pts.push({ x: Number(move[1]), y: Number(move[2]) });
  const cubic = /C\s+-?[\d.]+\s+-?[\d.]+,\s*-?[\d.]+\s+-?[\d.]+,\s*(-?[\d.]+)\s+(-?[\d.]+)/g;
  for (const m of d.matchAll(cubic)) pts.push({ x: Number(m[1]), y: Number(m[2]) });
  return pts;
}

/** Every on-curve point of every crest of one wave. */
function wavePoints(w: { arcs: { d: string }[] }): Pt[] {
  return w.arcs.flatMap((a) => onCurvePoints(a.d));
}

/**
 * How far `p` stands off the coast, measured along its own bearing.
 *
 * Index pairing is no longer available: a crest is a *slice* of the ring starting at an
 * arbitrary vertex, so its nth point is not the coast's nth point. Nearest bearing is,
 * and the coast's vertices are evenly spaced in angle by construction.
 */
function reachOf(p: Pt, origin: Pt, coast: readonly Pt[]): number {
  const bearing = Math.atan2(p.y - origin.y, p.x - origin.x);
  let best = 0;
  let bestGap = Infinity;
  for (const c of coast) {
    const a = Math.atan2(c.y - origin.y, c.x - origin.x);
    let gap = Math.abs(a - bearing);
    if (gap > Math.PI) gap = Math.PI * 2 - gap;
    if (gap < bestGap) {
      bestGap = gap;
      best = Math.hypot(c.x - origin.x, c.y - origin.y);
    }
  }
  return Math.hypot(p.x - origin.x, p.y - origin.y) - best;
}

/** Largest run of bearings, in radians, with no crest in it. */
function widestSilence(points: readonly Pt[], origin: Pt): number {
  const bearings = points
    .map((p) => Math.atan2(p.y - origin.y, p.x - origin.x))
    .sort((a, b) => a - b);
  let widest = 0;
  for (let i = 0; i < bearings.length; i++) {
    const next = i === bearings.length - 1 ? bearings[0] + Math.PI * 2 : bearings[i + 1];
    widest = Math.max(widest, next - bearings[i]);
  }
  return widest;
}

describe('coastalSwell', () => {
  it('gives back nothing for a degenerate coast rather than throwing', () => {
    for (const coast of [[], [{ x: 1, y: 1 }], [{ x: 1, y: 1 }, { x: 2, y: 2 }]]) {
      expect(coastalSwell(coast, 1).waves).toEqual([]);
    }
  });

  it('stands every ring off the shore, inside the shelf', () => {
    for (const seed of SEEDS) {
      const world = generateWorld(seed);
      const { waves } = coastalSwell(world.coast, seed);
      expect(waves).toHaveLength(SWELL_RINGS);

      for (const w of waves) {
        // Offshore, but never past the blurred shallow band the map draws.
        expect(w.offset, `seed ${seed}`).toBeGreaterThan(0);
        expect(w.offset, `seed ${seed}`).toBeLessThanOrEqual(SWELL_REACH);
      }
    }
  });

  it('draws each ring outside the coastline it came from', () => {
    for (const seed of SEEDS) {
      const world = generateWorld(seed);
      const origin = centroid(world.coast);

      for (const w of coastalSwell(world.coast, seed).waves) {
        const pts = wavePoints(w);
        expect(pts.length).toBeGreaterThan(2);
        for (const p of pts) {
          expect(reachOf(p, origin, world.coast), `seed ${seed} ring ${w.offset}`)
            .toBeGreaterThan(0);
        }
      }
    }
  });

  it('is not the coastline traced again — the offshore distance varies along a ring', () => {
    // The whole point of the change that added the wobble. Offsetting the coast by one
    // constant distance produces a shape *similar* to it, so a stack of rings reads as
    // a contour map: perfectly nested curves, each parallel to the shore and to every
    // other ring. No amount of tuning width or opacity fixes that, because the defect
    // is that the shapes are similar — so this asserts they are not.
    for (const seed of SEEDS) {
      const world = generateWorld(seed);
      const origin = centroid(world.coast);

      for (const w of coastalSwell(world.coast, seed).waves) {
        const gaps = wavePoints(w).map((p) => reachOf(p, origin, world.coast));
        const spread = Math.max(...gaps) - Math.min(...gaps);
        expect(spread, `seed ${seed} ring ${w.offset}`).toBeGreaterThan(4);
      }
    }
  });

  it('breaks every wave into separate crests, none of them a closed ring', () => {
    // A wave is not a line drawn all the way round an island. An unbroken curve
    // returning to its own start is a boundary — the eye follows it round rather than
    // across — so however irregular its shape, a closed ring reads as a racetrack
    // marking. Real swell shows as arcs that rise, die, and pick up further along.
    for (const seed of SEEDS) {
      const world = generateWorld(seed);
      for (const w of coastalSwell(world.coast, seed).waves) {
        expect(w.arcs.length, `seed ${seed} ring ${w.offset}`).toBeGreaterThan(1);
        for (const a of w.arcs) {
          expect(a.d.endsWith('Z'), `seed ${seed}`).toBe(false);
          expect(a.d, `seed ${seed}`).not.toContain('NaN');
          expect(onCurvePoints(a.d).length, `seed ${seed}`).toBeGreaterThanOrEqual(3);
          expect(a.strokeWidth, `seed ${seed}`).toBeGreaterThan(0);
          expect(a.opacity, `seed ${seed}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('varies the crests so a wave is not read as one dashed line', () => {
    // Equal-weight arcs at equal spacing are a dash pattern, which is the thing being
    // avoided — so both the weights and the arc lengths have to differ.
    for (const seed of SEEDS) {
      const world = generateWorld(seed);
      const all = coastalSwell(world.coast, seed).waves.flatMap((w) => w.arcs);
      const widths = new Set(all.map((a) => a.strokeWidth.toFixed(3)));
      const alphas = new Set(all.map((a) => a.opacity.toFixed(3)));
      // Lengths are counted over the whole swell, not per ring: two crests of one ring
      // may honestly come out the same length, and asserting otherwise would be
      // asserting that the dice cannot repeat.
      const lengths = new Set(all.map((a) => onCurvePoints(a.d).length));
      expect(widths.size, `seed ${seed}`).toBeGreaterThan(1);
      expect(alphas.size, `seed ${seed}`).toBeGreaterThan(1);
      expect(lengths.size, `seed ${seed}`).toBeGreaterThan(1);
    }
  });

  it('leaves a sheltered stretch of shore with no crest on it at all', () => {
    // Swell arrives from a direction. Standing an equal band off every side says the
    // water is closing in from everywhere at once, which is a ripple in a pond. Drawing
    // the lee *fainter* is not enough either — distance and opacity both still say
    // "wave, over there". Dropping the arc says there is no wave there, which is what
    // being sheltered means.
    for (const seed of SEEDS) {
      const world = generateWorld(seed);
      const origin = centroid(world.coast);
      const outer = coastalSwell(world.coast, seed).waves[0];
      // A quarter-turn of shore or more carries nothing.
      expect(widestSilence(wavePoints(outer), origin), `seed ${seed}`).toBeGreaterThan(
        Math.PI / 4,
      );
    }
  });

  it('staggers the seams between rings so they do not punch a corridor', () => {
    // The shape harmonics are shared across rings, or the rings cross. The *gaps* must
    // not be: aligned seams cut a visible channel straight through the swell.
    for (const seed of SEEDS) {
      const world = generateWorld(seed);
      const origin = centroid(world.coast);
      const starts = coastalSwell(world.coast, seed).waves.map((w) =>
        w.arcs
          .map((a) => onCurvePoints(a.d)[0])
          .map((p) => Math.atan2(p.y - origin.y, p.x - origin.x).toFixed(3))
          .join(','),
      );
      // Not "every ring differs from every other" — two rings of four happening to
      // share a seam is not a corridor. Every ring cutting in the same places is.
      expect(new Set(starts).size, `seed ${seed}`).toBeGreaterThan(1);
    }
  });

  it('contracts shoreward — never expands out to sea', () => {
    for (const seed of SEEDS) {
      for (const w of coastalSwell(generateWorld(seed).coast, seed).waves) {
        expect(w.to, `seed ${seed}`).toBeGreaterThan(0);
        expect(w.to, `seed ${seed}`).toBeLessThan(1);
      }
    }
  });

  it('lands the outermost ring on the shore, not short of it or past it', () => {
    // `to` has to carry a ring from where it actually stands down to the same break
    // line every other ring reaches, or the bands cross on the way in. Measured from
    // `reach`, not `offset`: the wobble and the lee move a ring off its nominal
    // station, and scaling from the station it no longer occupies is the bug this
    // guards.
    for (const seed of SEEDS) {
      const world = generateWorld(seed);
      const origin = centroid(world.coast);
      let radius = 0;
      for (const p of world.coast) radius += Math.hypot(p.x - origin.x, p.y - origin.y);
      radius /= world.coast.length;

      const breaks = coastalSwell(world.coast, seed).waves.map((w) => (radius + w.reach) * w.to);
      for (const b of breaks) expect(b).toBeCloseTo(breaks[0], 6);
    }
  });

  it('fades and thins the closer a ring is to breaking', () => {
    // Ordered outermost first, so opacity climbs and width falls down the list.
    for (const seed of SEEDS) {
      const waves = coastalSwell(generateWorld(seed).coast, seed).waves;
      for (let i = 1; i < waves.length; i++) {
        expect(waves[i].offset).toBeLessThan(waves[i - 1].offset);
        expect(waves[i].strokeWidth).toBeLessThan(waves[i - 1].strokeWidth);
        expect(waves[i].opacity).toBeGreaterThan(waves[i - 1].opacity);
      }
    }
  });

  it('staggers the rings so the swell is continuous, and starts mid-cycle', () => {
    const waves = coastalSwell(generateWorld(20260806).coast, 20260806).waves;
    const delays = waves.map((w) => w.delay);
    expect(new Set(delays).size).toBe(waves.length);
    for (const w of waves) {
      expect(w.delay).toBeLessThanOrEqual(0);
      expect(w.dur).toBeGreaterThan(0);
      expect(w.opacity).toBeGreaterThan(0);
      expect(w.opacity).toBeLessThan(1);
    }
  });

  it('is stable for a seed and differs between seeds', () => {
    const world = generateWorld(4242);
    const a = coastalSwell(world.coast, 4242);
    const b = coastalSwell(world.coast, 4242);
    expect(a).toEqual(b);

    const c = coastalSwell(world.coast, 4243);
    expect(c.waves.map((w) => w.dur)).not.toEqual(a.waves.map((w) => w.dur));
  });
});

describe('coastalSurf', () => {
  it('gives back nothing for a degenerate coast rather than throwing', () => {
    for (const coast of [[], [{ x: 1, y: 1 }], [{ x: 1, y: 1 }, { x: 2, y: 2 }]]) {
      expect(coastalSurf(coast, 1)).toBeNull();
    }
  });

  it('is a band with two edges, not a stroke', () => {
    // The inner edge is the shoreline exactly and the outer one scallops. A stroke can
    // only ever be the shoreline offset by one number, which is the defect the swell
    // rings had — so the shape has to be two rings in one subpath.
    for (const seed of SEEDS) {
      const surf = coastalSurf(generateWorld(seed).coast, seed);
      expect(surf, `seed ${seed}`).not.toBeNull();
      expect(surf!.d.match(/M/g), `seed ${seed}`).toHaveLength(2);
      expect(surf!.d.match(/Z/g), `seed ${seed}`).toHaveLength(2);
      expect(surf!.d, `seed ${seed}`).not.toContain('NaN');
    }
  });

  it('scallops the outer edge instead of standing off evenly', () => {
    for (const seed of SEEDS) {
      const world = generateWorld(seed);
      const origin = centroid(world.coast);
      // The first subpath is the outer edge; measure it against the shore's own radius.
      const outer = onCurvePoints(coastalSurf(world.coast, seed)!.d.split(' M')[0]);
      const reaches = outer.map((p) => reachOf(p, origin, world.coast));
      expect(Math.min(...reaches), `seed ${seed}`).toBeGreaterThan(0);
      // Slack of half a pixel: `reachOf` measures against the nearest coast vertex by
      // bearing, which for an offset ring is not always the vertex it was offset from.
      expect(Math.max(...reaches), `seed ${seed}`).toBeLessThanOrEqual(SURF_REACH + 0.5);
      // Lobes: the deepest spray is several times the pinch between.
      expect(Math.max(...reaches), `seed ${seed}`).toBeGreaterThan(Math.min(...reaches) * 2);
    }
  });
});

describe('whitecaps', () => {
  it('never puts a cap on land', () => {
    // The one invariant that matters: a whitecap over the grass is not a wave, it is
    // a scratch on the island.
    for (const seed of SEEDS) {
      const world = generateWorld(seed);
      const caps = whitecaps(world.coast, world.islets, WORLD_W, WORLD_H, seed);
      expect(caps.length, `seed ${seed}`).toBeGreaterThan(0);
      expect(caps.length, `seed ${seed}`).toBeLessThanOrEqual(MAX_WHITECAPS);
      for (const cap of caps) {
        for (const p of onCurvePoints(cap.d)) {
          expect(pointInPolygon(p, world.coast), `seed ${seed} at ${p.x},${p.y}`).toBe(false);
        }
      }
    }
  });

  it('curves each cap, and staggers them so they are not all bright at once', () => {
    for (const seed of SEEDS) {
      const world = generateWorld(seed);
      const caps = whitecaps(world.coast, world.islets, WORLD_W, WORLD_H, seed);
      for (const cap of caps) {
        expect(cap.d, `seed ${seed}`).toContain('C');
        expect(cap.d, `seed ${seed}`).not.toContain('NaN');
        expect(cap.strokeWidth, `seed ${seed}`).toBeGreaterThan(0);
        expect(cap.dur, `seed ${seed}`).toBeGreaterThan(0);
        expect(cap.delay, `seed ${seed}`).toBeLessThanOrEqual(0);
      }
      expect(new Set(caps.map((c) => c.delay.toFixed(3))).size, `seed ${seed}`)
        .toBeGreaterThan(1);
    }
  });

  it('keeps the caps near the island rather than over the whole frame', () => {
    // Confetti to the corners is not a sea; the open water in the reference is bare.
    for (const seed of SEEDS) {
      const world = generateWorld(seed);
      const caps = whitecaps(world.coast, world.islets, WORLD_W, WORLD_H, seed);
      for (const cap of caps) {
        const p = onCurvePoints(cap.d)[0];
        let near = Infinity;
        for (const c of world.coast) near = Math.min(near, Math.hypot(p.x - c.x, p.y - c.y));
        expect(near, `seed ${seed}`).toBeLessThan(320);
      }
    }
  });

  it('is empty for a degenerate coast', () => {
    expect(whitecaps([], [], WORLD_W, WORLD_H, 1)).toEqual([]);
  });
});

describe('seaPatches', () => {
  it('covers the sea with closed flat areas and a tone the palette can index', () => {
    for (const seed of SEEDS) {
      const patches = seaPatches(WORLD_W, WORLD_H, seed);
      expect(patches, `seed ${seed}`).toHaveLength(SEA_PATCHES);
      for (const patch of patches) {
        expect(patch.d.endsWith('Z'), `seed ${seed}`).toBe(true);
        expect(patch.d, `seed ${seed}`).not.toContain('NaN');
        expect(patch.tone, `seed ${seed}`).toBeGreaterThanOrEqual(0);
        expect(patch.tone, `seed ${seed}`).toBeLessThanOrEqual(2);
        expect(patch.opacity, `seed ${seed}`).toBeGreaterThan(0);
        expect(patch.opacity, `seed ${seed}`).toBeLessThan(0.5);
      }
    }
  });

  it('is stable for a seed and differs between seeds', () => {
    expect(seaPatches(WORLD_W, WORLD_H, 7)).toEqual(seaPatches(WORLD_W, WORLD_H, 7));
    expect(seaPatches(WORLD_W, WORLD_H, 7)).not.toEqual(seaPatches(WORLD_W, WORLD_H, 8));
  });
});
