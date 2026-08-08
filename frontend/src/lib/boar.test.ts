import { describe, it, expect } from 'vitest';
import {
  BOAR_VIEWBOX, CENTRE_X, NEON, CHROMA_OFFSET, SPLASH, EYE_IDS,
  SPARK_ORIGINS, SPARK_REACH,
  boarStrokes, boarFacets, glitchBands, sparks, mirrorPath,
} from './boar';

/**
 * Every path in boar.ts is absolute M/C/Z, which is asserted below — that is
 * what makes this parser exact rather than approximate, and it is the same
 * property `mirrorPath` depends on to know which numbers are x.
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
const allPaths = [
  ...strokes.map(s => ({ id: s.id, d: s.d })),
  ...facets.map(f => ({ id: f.id, d: f.d })),
];

describe('boar paths', () => {
  it.each(allPaths.map(p => [p.id, p.d] as const))('%s uses only absolute M/C/Z', (_id, d) => {
    // Any other command (relative m/c, or H/V/A/S/Q) would put an odd number of
    // coordinates in the stream — which would break the pairing above and,
    // worse, make mirrorPath reflect y values into x.
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
    // into a loop of wire hanging beside the jaw.
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

describe('mirrorPath', () => {
  const cases: Array<[string, string, string]> = [
    ['reflects x and leaves y alone', 'M100 50', 'M340 50'],
    ['leaves the centre line fixed', 'M220 10', 'M220 10'],
    ['handles every pair of a curve', 'M100 20 C110 30, 120 40, 130 50', 'M340 20 C330 30, 320 40, 310 50'],
    ['carries Z through', 'M100 20 C110 30, 120 40, 130 50 Z', 'M340 20 C330 30, 320 40, 310 50 Z'],
    ['reflects past the centre', 'M400 8', 'M40 8'],
    ['keeps one-decimal inputs clean', 'M100.5 20.5', 'M339.5 20.5'],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(mirrorPath(input)).toBe(expected);
  });

  it('is its own inverse', () => {
    for (const { d } of allPaths) expect(mirrorPath(mirrorPath(d))).toBe(d);
  });

  it('honours an explicit centre', () => {
    expect(mirrorPath('M10 5', 50)).toBe('M90 5');
  });
});

describe('symmetry', () => {
  // A frontal face has to be symmetric, and hand-authoring both halves is how a
  // tusk ends up two pixels longer on one side — invisible in the source and
  // glaring on screen. Only the left half is written down; these hold the
  // machinery that produces the right.
  const mirrored = strokes.filter(s => s.id.endsWith('-r'));

  it('has a mirrored partner for every half-stroke', () => {
    expect(mirrored.length).toBeGreaterThan(0);
    for (const m of mirrored) {
      const source = strokes.find(s => s.id === m.id.slice(0, -2));
      expect(source, `no source for ${m.id}`).toBeDefined();
      expect(m.d).toBe(mirrorPath(source!.d));
    }
  });

  it('keeps a mirrored stroke identical to its source in every other way', () => {
    for (const m of mirrored) {
      const source = strokes.find(s => s.id === m.id.slice(0, -2))!;
      expect(m.color).toBe(source.color);
      expect(m.width).toBe(source.width);
      expect(m.role).toBe(source.role);
      expect(m.fill).toBe(source.fill);
    }
  });

  it('draws each half-stroke next to its mirror, so the face never builds lopsided', () => {
    for (const m of mirrored) {
      const i = strokes.indexOf(m);
      expect(strokes[i - 1].id).toBe(m.id.slice(0, -2));
    }
  });

  it('centres the whole drawing on the mirror line', () => {
    const xs = allPaths.flatMap(p => pathPoints(p.d).map(([x]) => x));
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(2 * CENTRE_X, 6);
  });
});

describe('draw order', () => {
  // The order IS the reveal: skull and ears, then the face, then the muzzle and
  // snout, then the tusks that frame the whole thing, eyes last. Reordering the
  // arrays in boar.ts is a one-line change that would silently ruin the only
  // timing the splash has, so it is pinned here.
  it('starts with the silhouette', () => {
    expect(strokes[0].role).toBe('silhouette');
  });

  it('draws the head before the tusks', () => {
    const lastHead = strokes.map(s => s.role).lastIndexOf('silhouette');
    const firstTusk = strokes.findIndex(s => s.role === 'tusk');
    expect(firstTusk).toBeGreaterThan(lastHead);
  });

  it('lights both eyes last of all', () => {
    expect(strokes.slice(-EYE_IDS.length).map(s => s.id).sort())
      .toEqual([...EYE_IDS].sort());
  });

  it('is stable across calls', () => {
    expect(boarStrokes().map(s => s.id)).toEqual(strokes.map(s => s.id));
    expect(boarStrokes().map(s => s.d)).toEqual(strokes.map(s => s.d));
  });

  it('has two ears, two tusks, two eyes and a mane', () => {
    const count = (role: string) => strokes.filter(s => s.role === role).length;
    // Skull and ear, each mirrored.
    expect(count('silhouette')).toBe(4);
    expect(count('tusk')).toBe(2);
    expect(count('bristle')).toBeGreaterThanOrEqual(16);
    expect(strokes.filter(s => s.id.startsWith('ear'))).toHaveLength(2);
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
    ['the eyes light', SPLASH.eyeAt],
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

  it('stays within reach of the point it came off', () => {
    // Measured against the origins rather than a hand-copied bounding box, which
    // stops meaning anything the moment a tusk moves. Clamping only ever pulls a
    // spark inward, so the reach is an upper bound.
    for (const s of sparks(4, 60)) {
      const nearest = Math.min(
        ...SPARK_ORIGINS.map(([ox, oy]) => Math.hypot(s.x - ox, s.y - oy)),
      );
      expect(nearest).toBeLessThanOrEqual(SPARK_REACH);
    }
  });

  it('throws every spark upward, so none drop through the jaw', () => {
    for (const s of sparks(4, 60)) {
      const [, oy] = SPARK_ORIGINS.reduce(
        (best, o) => (Math.hypot(s.x - o[0], s.y - o[1]) < Math.hypot(s.x - best[0], s.y - best[1]) ? o : best),
        SPARK_ORIGINS[0],
      );
      expect(s.y).toBeLessThanOrEqual(oy);
    }
  });

  it('fits its whole shower inside the spark beat', () => {
    for (const s of sparks(4, 40)) {
      expect(s.delay).toBeGreaterThanOrEqual(0);
      expect(SPLASH.sparksAt + s.delay).toBeLessThan(SPLASH.exitAt);
    }
  });
});
