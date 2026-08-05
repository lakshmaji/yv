import { describe, it, expect } from 'vitest';
import {
  catmullRomPath,
  centroid,
  clampInside,
  dist,
  insetPolygon,
  jitterRing,
  lerp,
  nearestIndex,
  pointInPolygon,
  polygonPath,
  type Pt,
} from './geometry';
import { makeRng } from './rng';

const SQUARE: Pt[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

describe('lerp / dist / centroid', () => {
  it('interpolates', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(lerp(-4, 4, 0.5)).toBe(0);
  });

  it('measures distance', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('averages the points', () => {
    expect(centroid(SQUARE)).toEqual({ x: 50, y: 50 });
  });

  it('returns the origin for an empty polygon', () => {
    expect(centroid([])).toEqual({ x: 0, y: 0 });
  });
});

describe('catmullRomPath', () => {
  it('returns an empty string for no points', () => {
    expect(catmullRomPath([])).toBe('');
  });

  it('emits a bare moveto for one point', () => {
    expect(catmullRomPath([{ x: 1, y: 2 }])).toBe('M 1 2');
  });

  it('emits a line for two points', () => {
    expect(catmullRomPath([{ x: 0, y: 0 }, { x: 5, y: 5 }])).toBe('M 0 0 L 5 5');
  });

  it('emits cubics and no Z when open', () => {
    const d = catmullRomPath(SQUARE, false);
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d).toContain('C');
    expect(d.endsWith('Z')).toBe(false);
    // Open curves stop at the last point: 4 points → 3 segments.
    expect(d.match(/C/g)).toHaveLength(3);
  });

  it('closes the ring and returns to the start when closed', () => {
    const d = catmullRomPath(SQUARE, true);
    expect(d.endsWith('Z')).toBe(true);
    // Closed rings need one segment per edge, including the seam.
    expect(d.match(/C/g)).toHaveLength(4);
  });

  it('never emits NaN', () => {
    expect(catmullRomPath(SQUARE, true)).not.toContain('NaN');
  });
});

describe('polygonPath', () => {
  it('is empty for no points', () => {
    expect(polygonPath([])).toBe('');
  });

  it('emits linetos and closes', () => {
    expect(polygonPath(SQUARE)).toBe('M 0 0 L 100 0 L 100 100 L 0 100 Z');
  });
});

describe('pointInPolygon', () => {
  const cases: [string, Pt, boolean][] = [
    ['centre', { x: 50, y: 50 }, true],
    ['just inside a corner', { x: 1, y: 1 }, true],
    ['well outside', { x: 200, y: 50 }, false],
    ['above', { x: 50, y: -1 }, false],
    ['below', { x: 50, y: 101 }, false],
    ['left', { x: -0.5, y: 50 }, false],
  ];
  for (const [name, p, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(pointInPolygon(p, SQUARE)).toBe(expected);
    });
  }
});

describe('insetPolygon', () => {
  it('shrinks toward the centroid and keeps the point count', () => {
    const inner = insetPolygon(SQUARE, 10);
    expect(inner).toHaveLength(4);
    const c = centroid(SQUARE);
    for (let i = 0; i < inner.length; i++) {
      expect(dist(inner[i], c)).toBeLessThan(dist(SQUARE[i], c));
      expect(pointInPolygon(inner[i], SQUARE)).toBe(true);
    }
  });

  it('collapses to the centroid rather than inverting when over-inset', () => {
    const inner = insetPolygon(SQUARE, 10_000);
    for (const p of inner) {
      expect(p).toEqual({ x: 50, y: 50 });
    }
  });
});

describe('jitterRing', () => {
  it('is deterministic for a seed and produces the requested count', () => {
    const a = jitterRing(50, 50, 40, 30, 16, makeRng(7));
    const b = jitterRing(50, 50, 40, 30, 16, makeRng(7));
    expect(a).toEqual(b);
    expect(a).toHaveLength(16);
  });

  it('keeps every radius within the wobble amplitude', () => {
    const amp = 0.2;
    const pts = jitterRing(0, 0, 100, 100, 40, makeRng(11), amp);
    for (const p of pts) {
      const r = Math.hypot(p.x, p.y);
      expect(r).toBeGreaterThan(100 * (1 - amp - 1e-9));
      expect(r).toBeLessThan(100 * (1 + amp + 1e-9));
    }
  });

  it('emits only finite coordinates', () => {
    for (const p of jitterRing(10, 20, 5, 5, 24, makeRng(3), 0.4)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe('clampInside', () => {
  const anchor = { x: 50, y: 50 };

  it('leaves an interior point untouched', () => {
    expect(clampInside({ x: 60, y: 40 }, SQUARE, anchor)).toEqual({ x: 60, y: 40 });
  });

  it('pulls an exterior point inside', () => {
    const p = clampInside({ x: 400, y: 50 }, SQUARE, anchor);
    expect(pointInPolygon(p, SQUARE)).toBe(true);
    // It should land near the boundary, not collapse onto the anchor.
    expect(p.x).toBeGreaterThan(90);
  });

  it('handles points outside on both axes', () => {
    for (const outside of [{ x: -80, y: -90 }, { x: 300, y: 400 }, { x: 50, y: -20 }]) {
      expect(pointInPolygon(clampInside(outside, SQUARE, anchor), SQUARE)).toBe(true);
    }
  });
});

describe('nearestIndex', () => {
  it('finds the closest point', () => {
    expect(nearestIndex({ x: 99, y: 99 }, SQUARE)).toBe(2);
  });

  it('is -1 for an empty list', () => {
    expect(nearestIndex({ x: 0, y: 0 }, [])).toBe(-1);
  });
});
