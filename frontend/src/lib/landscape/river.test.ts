import { describe, it, expect } from 'vitest';
import {
  bankPad,
  RIVER_STEP,
  flowStreaks,
  riverBanks,
  riverRibbon,
  riverSeed,
  shoalPath,
  widestDrawn,
} from './river';
import { WATER_RESERVE, generateWorld, type River } from './world';
import { dist, pointInPolygon, type Pt } from './geometry';

// The same spread of seeds world.test.ts uses, so a property that only holds for
// one lucky world fails here too.
const SEEDS = [1, 7, 42, 1234, 20260806, 999999, 0];

/**
 * On-curve points of a path string: the moveto, then the endpoint of each cubic.
 *
 * The bezier control points are deliberately skipped — they sit off the curve by
 * design, so including them would make a containment test fail on shapes that are
 * perfectly contained.
 */
function onCurvePoints(d: string): Pt[] {
  const pts: Pt[] = [];
  const move = d.match(/^M\s+(-?[\d.]+)\s+(-?[\d.]+)/);
  if (move) pts.push({ x: Number(move[1]), y: Number(move[2]) });
  const cubic = /C\s+-?[\d.]+\s+-?[\d.]+,\s*-?[\d.]+\s+-?[\d.]+,\s*(-?[\d.]+)\s+(-?[\d.]+)/g;
  for (const m of d.matchAll(cubic)) pts.push({ x: Number(m[1]), y: Number(m[2]) });
  return pts;
}

/**
 * The channel outline as actually drawn, for containment checks.
 *
 * Deliberately the on-curve points of the emitted path rather than the raw bank
 * polylines: the smoothing bows outside the polyline it was fitted to, so testing
 * against the polyline would fail on shapes that are drawn perfectly contained.
 */
function bodyPolygon(river: River): Pt[] {
  return onCurvePoints(riverRibbon(river).body);
}

function everyRiver(fn: (river: River, seed: number, index: number) => void): void {
  for (const seed of SEEDS) {
    const world = generateWorld(seed);
    world.rivers.forEach((river, index) => fn(river, seed, index));
  }
}

describe('riverBanks', () => {
  it('resamples enough of the curve to make a ribbon, even from three points', () => {
    everyRiver((river, seed, i) => {
      const banks = riverBanks(river, riverSeed(river));
      const where = `seed ${seed} river ${i}`;
      // A tributary has exactly three control points. Offsetting those directly
      // would give a bent stick; this is the assertion that the curve, not the
      // control polyline, is what got sampled.
      expect(banks.center.length, where).toBeGreaterThanOrEqual(8);
      expect(banks.left.length, where).toBe(banks.center.length);
      expect(banks.right.length, where).toBe(banks.center.length);
      expect(banks.half.length, where).toBe(banks.center.length);
      expect(banks.tangent.length, where).toBe(banks.center.length);
      expect(banks.s.length, where).toBe(banks.center.length);
    });
  });

  it('spaces the samples evenly along the course', () => {
    everyRiver((river, seed, i) => {
      const banks = riverBanks(river, riverSeed(river));
      // Chord, not arc: the samples are a fixed arc length apart along a curve, so
      // the straight-line gap is at most the step and shrinks as the course bends.
      // The last span is short by construction — the true end is always kept.
      const gaps: number[] = [];
      for (let k = 1; k < banks.center.length - 1; k++) {
        gaps.push(dist(banks.center[k - 1], banks.center[k]));
      }
      const where = `seed ${seed} river ${i}`;
      // The step adapts down on a short course, so what matters is that the spacing
      // is uniform and never coarser than RIVER_STEP — not that it equals it.
      expect(Math.max(...gaps), where).toBeLessThanOrEqual(RIVER_STEP + 1e-9);
      expect(Math.min(...gaps), where).toBeGreaterThan(Math.max(...gaps) * 0.9);
      expect(banks.s[0]).toBe(0);
      expect(banks.s[banks.s.length - 1]).toBeCloseTo(1, 9);
    });
  });

  it('never folds a bank back on itself', () => {
    // The pinch proof, and the only assertion that actually protects the look: at
    // a tight enough meander an offset wider than the radius of curvature makes the
    // inner bank reverse direction, and the ribbon draws as a bow tie.
    everyRiver((river, seed, i) => {
      const banks = riverBanks(river, riverSeed(river));
      for (const side of [banks.left, banks.right]) {
        for (let k = 0; k < side.length - 1; k++) {
          const t = banks.tangent[k];
          const advance = (side[k + 1].x - side[k].x) * t.x + (side[k + 1].y - side[k].y) * t.y;
          expect(advance, `seed ${seed} river ${i} sample ${k}`).toBeGreaterThan(0);
        }
      }
    });
  });

  it('gives the two banks different shapes', () => {
    // Mirror-image banks are what made the old constant-width stroke read as a
    // pipe; the per-side wobble is the whole point of this file.
    everyRiver((river) => {
      const banks = riverBanks(river, riverSeed(river));
      const lefts = banks.left.map((p, k) => dist(p, banks.center[k]));
      const rights = banks.right.map((p, k) => dist(p, banks.center[k]));
      const spread = lefts.reduce((acc, l, k) => acc + Math.abs(l - rights[k]), 0);
      expect(spread).toBeGreaterThan(0);
    });
  });

  it('stays inside the clearance the scatter passes reserved', () => {
    // Non-regression against openGround: whatever we draw has to fit inside the
    // obstacle discs the generator already reserved, or a tree that was legally
    // placed ends up standing in water.
    everyRiver((river, seed, i) => {
      const banks = riverBanks(river, riverSeed(river));
      expect(widestDrawn(river, banks), `seed ${seed} river ${i}`)
        .toBeLessThanOrEqual(river.width * WATER_RESERVE);
    });
  });

  it('emits only finite numbers', () => {
    everyRiver((river) => {
      const banks = riverBanks(river, riverSeed(river));
      for (const key of ['center', 'tangent', 'left', 'right'] as const) {
        for (const p of banks[key]) {
          expect(Number.isFinite(p.x)).toBe(true);
          expect(Number.isFinite(p.y)).toBe(true);
        }
      }
      for (const n of [...banks.half, ...banks.s, banks.length]) {
        expect(Number.isFinite(n)).toBe(true);
      }
    });
  });
});

describe('shoalPath', () => {
  it('keeps the lit band inside the channel', () => {
    everyRiver((river, seed, i) => {
      const banks = riverBanks(river, riverSeed(river));
      const polygon = bodyPolygon(river);
      for (const p of onCurvePoints(shoalPath(banks))) {
        expect(pointInPolygon(p, polygon), `seed ${seed} river ${i} at ${p.x},${p.y}`).toBe(true);
      }
    });
  });

  it('closes, and writes no NaN', () => {
    everyRiver((river) => {
      const d = shoalPath(riverBanks(river, riverSeed(river)));
      expect(d.endsWith('Z')).toBe(true);
      expect(d).not.toContain('NaN');
    });
  });
});

describe('flowStreaks', () => {
  it('never spills a streak onto the land', () => {
    everyRiver((river, seed, i) => {
      const banks = riverBanks(river, riverSeed(river));
      const polygon = bodyPolygon(river);
      for (const streak of flowStreaks(banks, riverSeed(river))) {
        for (const p of onCurvePoints(streak.d)) {
          expect(pointInPolygon(p, polygon), `seed ${seed} river ${i} at ${p.x},${p.y}`).toBe(true);
        }
      }
    });
  });

  it('draws curves with a drift and a head start, not ticks', () => {
    everyRiver((river, seed, i) => {
      const banks = riverBanks(river, riverSeed(river));
      const streaks = flowStreaks(banks, riverSeed(river));
      const where = `seed ${seed} river ${i}`;
      for (const s of streaks) {
        expect(s.d, where).toContain('C');
        expect(s.d, where).not.toContain('NaN');
        expect(s.width, where).toBeGreaterThan(0);
        expect(s.opacity, where).toBeGreaterThan(0);
        expect(s.opacity, where).toBeLessThan(1);
        expect(s.dur, where).toBeGreaterThan(0);
        expect(s.delay, where).toBeLessThanOrEqual(0);
        // The two kinds move differently and cannot share an animation: a thread
        // carries a glint along itself, a ripple drifts bodily downstream.
        if (s.kind === 'ripple') {
          expect(Math.hypot(s.dx, s.dy), where).toBeGreaterThan(0);
          expect(s.dash, where).toBe('');
        } else {
          expect(s.dash, where).toMatch(/^[\d.]+ [\d.]+$/);
          expect(s.travel, where).toBeLessThan(0);
        }
      }
    });
  });

  it('lays streamlines down the channel, not just marks on it', () => {
    // A stream is described lengthwise. Detached short marks read as flecks *on* the
    // water; what says the water is flowing is a set of lines running the reach and
    // following the banks, so every river has to carry some.
    everyRiver((river, seed, i) => {
      const banks = riverBanks(river, riverSeed(river));
      const streaks = flowStreaks(banks, riverSeed(river));
      const threads = streaks.filter((s) => s.kind === 'thread');
      const where = `seed ${seed} river ${i}`;
      expect(threads.length, where).toBeGreaterThan(0);
      for (const t of threads) {
        // Each spans most of the course rather than a few samples of it.
        const onCurve = onCurvePoints(t.d).length;
        expect(onCurve, where).toBeGreaterThan(banks.center.length * 0.4);
      }
    });
  });

  it('spreads the streamlines across the channel rather than stacking them', () => {
    // Depths drawn independently clump, and two threads on the same line read as one
    // heavy stroke — which is the centre stripe this whole change removed.
    for (const seed of SEEDS) {
      const trunk = generateWorld(seed).rivers[0];
      const banks = riverBanks(trunk, riverSeed(trunk));
      const threads = flowStreaks(banks, riverSeed(trunk)).filter((s) => s.kind === 'thread');
      if (threads.length < 2) continue;
      // Measured at the widest sample, where the threads have the most room to differ.
      const widest = banks.half.indexOf(Math.max(...banks.half));
      const at = threads
        .map((t) => onCurvePoints(t.d))
        .map((pts) => pts[Math.floor(pts.length / 2)])
        .map((p) => Math.hypot(p.x - banks.center[widest].x, p.y - banks.center[widest].y));
      expect(new Set(at.map((d) => d.toFixed(2))).size, `seed ${seed}`).toBe(at.length);
    }
  });

  it('gives a longer course more streaks', () => {
    for (const seed of SEEDS) {
      const world = generateWorld(seed);
      const trunk = world.rivers[0];
      const trunkStreaks = flowStreaks(riverBanks(trunk, riverSeed(trunk)), riverSeed(trunk));
      expect(trunkStreaks.length, `seed ${seed}`).toBeGreaterThan(0);
      for (const trib of world.rivers.slice(1)) {
        const banks = riverBanks(trib, riverSeed(trib));
        expect(flowStreaks(banks, riverSeed(trib)).length).toBeLessThanOrEqual(
          trunkStreaks.length + 1,
        );
      }
    }
  });
});

describe('riverRibbon', () => {
  it('is deterministic', () => {
    everyRiver((river) => {
      expect(riverRibbon(river)).toEqual(riverRibbon(river));
    });
  });

  it('closes every filled shape and writes no NaN', () => {
    everyRiver((river, seed, i) => {
      const r = riverRibbon(river);
      const where = `seed ${seed} river ${i}`;
      expect(r.fallback, where).toBeNull();
      for (const d of [r.bank, r.body, r.shoal]) {
        expect(d.endsWith('Z'), where).toBe(true);
        expect(d, where).not.toContain('NaN');
      }
    });
  });

  it('encloses the channel in the casing', () => {
    everyRiver((river, seed, i) => {
      const r = riverRibbon(river);
      const casing = onCurvePoints(r.bank);
      for (const p of onCurvePoints(r.body)) {
        expect(pointInPolygon(p, casing), `seed ${seed} river ${i}`).toBe(true);
      }
      expect(bankPad(river)).toBeGreaterThan(0);
    });
  });

  it('gives every river of a world its own streak phases', () => {
    for (const seed of SEEDS) {
      const seeds = generateWorld(seed).rivers.map(riverSeed);
      expect(new Set(seeds).size, `seed ${seed}`).toBe(seeds.length);
    }
  });

  it('falls back to a plain stroke for a course too short to be a ribbon', () => {
    const cases: [string, River][] = [
      ['one point', { points: [{ x: 10, y: 10 }], width: 8, widths: [8] }],
      ['two points', { points: [{ x: 0, y: 0 }, { x: 40, y: 0 }], width: 8, widths: [4, 8] }],
      [
        'widths out of step with points',
        { points: [{ x: 0, y: 0 }, { x: 20, y: 5 }, { x: 40, y: 0 }], width: 8, widths: [8] },
      ],
    ];
    for (const [name, river] of cases) {
      const r = riverRibbon(river);
      expect(r.fallback, name).not.toBeNull();
      expect(r.fallback?.width, name).toBeGreaterThan(0);
      expect(r.fallback?.d, name).not.toContain('NaN');
    }
  });

  it('survives a degenerate course without throwing or emitting NaN', () => {
    const cases: [string, River][] = [
      [
        'all points identical',
        {
          points: [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }],
          width: 10,
          widths: [3, 6, 8, 10],
        },
      ],
      [
        'zero width',
        {
          points: [{ x: 0, y: 0 }, { x: 30, y: 10 }, { x: 60, y: 0 }, { x: 90, y: 20 }],
          width: 0,
          widths: [0, 0, 0, 0],
        },
      ],
      [
        'a hairpin turn',
        {
          points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 4 }, { x: 0, y: 4 }],
          width: 30,
          widths: [20, 30, 30, 20],
        },
      ],
    ];
    for (const [name, river] of cases) {
      const r = riverRibbon(river);
      for (const d of [r.bank, r.body, r.shoal, ...r.streaks.map((s) => s.d)]) {
        expect(d, name).not.toContain('NaN');
        expect(d, name).not.toContain('Infinity');
      }
    }
  });
});
