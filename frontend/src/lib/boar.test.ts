import { describe, it, expect } from 'vitest';
import {
  BOAR_VIEWBOX, NEON, CHROMA_OFFSET, SPLASH, EYE_ID,
  boarStrokes, boarFacets, glitchBands, sparks,
} from './boar';

/**
 * Every path in boar.ts is absolute M/C/Z, which is asserted below — that is
 * what makes this parser exact rather than approximate, and it is the only
 * reason the containment test can pair numbers off as coordinates.
 */
function pathPoints(d: string): Array<[number, number]> {
  const nums = d.match(/-?\d+(?:\.\d+)?/g) ?? [];
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    out.push([Number(nums[i]), Number(nums[i + 1])]);
  }
  return out;
}

const strokes = boarStrokes();
const facets = boarFacets();
const allPaths = [...strokes.map(s => ({ id: s.id, d: s.d })), ...facets.map(f => ({ id: f.id, d: f.d }))];

describe('boar paths', () => {
  it.each(allPaths.map(p => [p.id, p.d] as const))('%s uses only absolute M/C/Z', (_id, d) => {
    // Any other command (relative m/c, or H/V/A/S/Q) would put an odd number of
    // coordinates in the stream and quietly break the pairing above.
    expect(d.replace(/[-\d.,\s]/g, '')).toMatch(/^M[CZ]*$/);
  });

  it.each(allPaths.map(p => [p.id, p.d] as const))('%s has an even, non-empty coordinate stream', (_id, d) => {
    const nums = d.match(/-?\d+(?:\.\d+)?/g) ?? [];
    expect(nums.length).toBeGreaterThan(0);
    expect(nums.length % 2).toBe(0);
  });

  it.each(allPaths.map(p => [p.id, p.d] as const))('%s is free of NaN', (_id, d) => {
    expect(d).not.toMatch(/NaN|Infinity|undefined/);
    for (const [x, y] of pathPoints(d)) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it.each(allPaths.map(p => [p.id, p.d] as const))('%s stays inside the viewBox', (_id, d) => {
    for (const [x, y] of pathPoints(d)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(BOAR_VIEWBOX.w);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(BOAR_VIEWBOX.h);
    }
  });

  it('gives every stroke a unique id', () => {
    const ids = strokes.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks closed shapes by their terminator, not by hand', () => {
    for (const s of strokes) {
      expect(s.closed).toBe(s.d.trimEnd().endsWith('Z'));
    }
  });

  it('draws every stroke with a positive width', () => {
    for (const s of strokes) expect(s.width).toBeGreaterThan(0);
  });

  it('fills the tusks and nothing else', () => {
    // A tusk is a solid object; every other stroke is a contour. Filling a
    // contour would flood the head, and leaving a tusk unfilled turns it back
    // into the loop of wire this replaced.
    for (const s of strokes) {
      expect(Boolean(s.fill)).toBe(s.role === 'tusk');
      if (s.fill) expect(s.closed).toBe(true);
    }
  });

  it('uses only palette colours', () => {
    const palette = new Set<string>(Object.values(NEON));
    for (const s of strokes) expect(palette.has(s.color)).toBe(true);
    for (const f of facets) expect(palette.has(f.color)).toBe(true);
  });
});

describe('draw order', () => {
  // The order IS the reveal: the head has to be recognisable before the tusks
  // arrive, and the eye is the last thing to switch on. Reordering the arrays in
  // boar.ts is a one-line change that would silently ruin the only timing the
  // splash has, so it is pinned here.
  const roleOf = (id: string) => strokes.findIndex(s => s.id === id);

  it('starts with the silhouette', () => {
    expect(strokes[0].role).toBe('silhouette');
  });

  it('draws the head before the tusks', () => {
    const lastHead = Math.max(...strokes.filter(s => s.role === 'silhouette' || s.role === 'interior').map(s => strokes.indexOf(s)));
    const firstTusk = strokes.findIndex(s => s.role === 'tusk');
    expect(firstTusk).toBeGreaterThan(lastHead);
  });

  it('lights the eye last of all', () => {
    expect(roleOf(EYE_ID)).toBe(strokes.length - 1);
  });

  it('is stable across calls', () => {
    expect(boarStrokes().map(s => s.id)).toEqual(strokes.map(s => s.id));
    expect(boarStrokes().map(s => s.d)).toEqual(strokes.map(s => s.d));
  });

  it('has a mane, three tusks and a full silhouette', () => {
    const count = (role: string) => strokes.filter(s => s.role === role).length;
    expect(count('bristle')).toBeGreaterThanOrEqual(8);
    expect(count('tusk')).toBe(2);
    expect(count('silhouette')).toBe(9);
  });
});

describe('SPLASH timings', () => {
  it('finishes exiting exactly at the total', () => {
    expect(SPLASH.exitAt + SPLASH.exitDur).toBe(SPLASH.total);
  });

  // The strokes overlap by drawStagger, so the wireframe is not finished until
  // the LAST one has run its full duration. Asserting drawStart + drawDur would
  // pass while most of the boar was still arriving after the glitch.
  const drawEnd = SPLASH.drawStart + (strokes.length - 1) * SPLASH.drawStagger + SPLASH.drawDur;

  it('finishes the whole staggered wireframe before the glitch hits it', () => {
    expect(drawEnd).toBeLessThanOrEqual(SPLASH.glitchAt);
  });

  const beats: Array<[string, number]> = [
    ['strokes finish drawing', drawEnd],
    ['facets finish', SPLASH.facetsAt + SPLASH.facetsDur],
    ['glitch finishes', SPLASH.glitchAt + SPLASH.glitchDur],
    ['the eye lights', SPLASH.eyeAt],
    ['the sparks fly', SPLASH.sparksAt],
    ['the wordmark lands', SPLASH.markAt + SPLASH.markDur],
  ];

  it.each(beats)('%s before the exit begins', (_name, end) => {
    expect(end).toBeLessThanOrEqual(SPLASH.exitAt);
  });

  it('leaves the reduced-motion path shorter than the full one', () => {
    expect(SPLASH.reducedHold + SPLASH.reducedFade).toBeLessThan(SPLASH.total);
  });

  it('splits the chroma copies symmetrically and visibly', () => {
    expect(CHROMA_OFFSET).toBeGreaterThan(0);
  });
});

describe('glitchBands', () => {
  it('is deterministic for a seed', () => {
    expect(glitchBands(7, 5)).toEqual(glitchBands(7, 5));
  });

  it('differs across seeds', () => {
    expect(glitchBands(7, 5)).not.toEqual(glitchBands(8, 5));
  });

  it('returns exactly the count asked for', () => {
    for (const n of [0, 1, 3, 12]) expect(glitchBands(3, n)).toHaveLength(n);
  });

  it('keeps every band inside the viewBox', () => {
    for (const b of glitchBands(42, 40)) {
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.h).toBeLessThanOrEqual(BOAR_VIEWBOX.h);
      expect(b.h).toBeGreaterThan(0);
    }
  });

  it('never emits a band that barely moves', () => {
    // A 1px shift reads as a rendering artefact rather than a glitch.
    for (const b of glitchBands(11, 60)) expect(Math.abs(b.dx)).toBeGreaterThanOrEqual(6);
  });

  it('displaces bands both ways', () => {
    const dxs = glitchBands(5, 40).map(b => b.dx);
    expect(dxs.some(dx => dx > 0)).toBe(true);
    expect(dxs.some(dx => dx < 0)).toBe(true);
  });
});

describe('sparks', () => {
  it('is deterministic for a seed', () => {
    expect(sparks(9, 12)).toEqual(sparks(9, 12));
  });

  it('differs across seeds', () => {
    expect(sparks(9, 12)).not.toEqual(sparks(10, 12));
  });

  it('keeps every spark, radius included, inside the viewBox', () => {
    for (const s of sparks(77, 60)) {
      expect(s.x - s.r).toBeGreaterThanOrEqual(0);
      expect(s.x + s.r).toBeLessThanOrEqual(BOAR_VIEWBOX.w);
      expect(s.y - s.r).toBeGreaterThanOrEqual(0);
      expect(s.y + s.r).toBeLessThanOrEqual(BOAR_VIEWBOX.h);
    }
  });

  it('flies upward and outward off the tusks', () => {
    // Every spark is thrown into the upper half-plane, so none of them drop
    // through the jaw.
    for (const s of sparks(4, 40)) expect(s.y).toBeLessThan(160);
  });

  it('fits its whole shower inside the spark beat', () => {
    for (const s of sparks(4, 40)) {
      expect(s.delay).toBeGreaterThanOrEqual(0);
      expect(SPLASH.sparksAt + s.delay).toBeLessThan(SPLASH.exitAt);
    }
  });
});
