import { describe, it, expect } from 'vitest';
import {
  catmullRomPath,
  catmullRomPoints,
  centroid,
  clampInside,
  curvatures,
  dist,
  insetPolygon,
  jitterRing,
  lerp,
  nearestIndex,
  normal,
  pointInPolygon,
  polygonPath,
  resample,
  sampleScalar,
  tangents,
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

describe('catmullRomPoints', () => {
  const OPEN: Pt[] = [
    { x: 0, y: 0 },
    { x: 50, y: 40 },
    { x: 120, y: 10 },
    { x: 180, y: 90 },
  ];

  it('samples every span and passes through every control point', () => {
    const per = 6;
    const out = catmullRomPoints(OPEN, per);
    expect(out).toHaveLength((OPEN.length - 1) * per + 1);
    for (let j = 0; j < OPEN.length; j++) {
      expect(out[j * per].x).toBeCloseTo(OPEN[j].x, 6);
      expect(out[j * per].y).toBeCloseTo(OPEN[j].y, 6);
    }
  });

  it('lands on the curve the path string draws', () => {
    // The final control point is the last coordinate pair the path emits, so the
    // two representations must agree at least there — the samples are not a
    // separate curve fitted alongside.
    const d = catmullRomPath(OPEN, false);
    const out = catmullRomPoints(OPEN, 4);
    const end = out[out.length - 1];
    expect(d.endsWith(`${end.x} ${end.y}`)).toBe(true);
  });

  it('survives degenerate input', () => {
    expect(catmullRomPoints([], 4)).toEqual([]);
    expect(catmullRomPoints([{ x: 3, y: 4 }], 4)).toEqual([{ x: 3, y: 4 }]);
    const dupe = catmullRomPoints([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }], 4);
    for (const p of dupe) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe('resample', () => {
  const LINE: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];

  it('walks at a fixed spacing and keeps both ends', () => {
    const out = resample(LINE, 20);
    expect(out[0].p).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1].p).toEqual({ x: 100, y: 100 });
    for (let i = 1; i < out.length - 1; i++) {
      expect(dist(out[i - 1].p, out[i].p)).toBeCloseTo(20, 6);
    }
  });

  it('reports a monotone fractional index into the source', () => {
    const out = resample(LINE, 7);
    expect(out[0].at).toBe(0);
    expect(out[out.length - 1].at).toBe(LINE.length - 1);
    for (let i = 1; i < out.length; i++) expect(out[i].at).toBeGreaterThanOrEqual(out[i - 1].at);
  });

  it('does not divide by a zero-length span', () => {
    const out = resample([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 50, y: 5 }], 10);
    for (const s of out) {
      expect(Number.isFinite(s.p.x)).toBe(true);
      expect(Number.isFinite(s.at)).toBe(true);
    }
  });

  it('degrades safely', () => {
    expect(resample([], 5)).toEqual([]);
    expect(resample(LINE, 0)).toHaveLength(1);
  });
});

describe('sampleScalar', () => {
  const VALUES = [10, 20, 40];

  it('reads exactly at whole indices and interpolates between them', () => {
    expect(sampleScalar(VALUES, 0)).toBe(10);
    expect(sampleScalar(VALUES, 2)).toBe(40);
    expect(sampleScalar(VALUES, 1.5)).toBe(30);
  });

  it('clamps outside the range instead of extrapolating', () => {
    expect(sampleScalar(VALUES, -4)).toBe(10);
    expect(sampleScalar(VALUES, 9)).toBe(40);
    expect(sampleScalar([], 1)).toBe(0);
  });
});

describe('tangents / normal', () => {
  it('is unit-length and constant along a straight line', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ];
    for (const t of tangents(line)) {
      expect(Math.hypot(t.x, t.y)).toBeCloseTo(1, 9);
      expect(t).toEqual({ x: 1, y: 0 });
    }
  });

  it('never returns NaN when consecutive points coincide', () => {
    // Reachable in the real data: a tributary ends exactly on a trunk vertex.
    const dupes = [
      { x: 4, y: 4 },
      { x: 4, y: 4 },
      { x: 40, y: 4 },
      { x: 40, y: 4 },
    ];
    for (const t of tangents(dupes)) {
      expect(Math.hypot(t.x, t.y)).toBeCloseTo(1, 9);
    }
    for (const t of tangents([{ x: 1, y: 1 }, { x: 1, y: 1 }])) {
      expect(Number.isFinite(t.x)).toBe(true);
      expect(Number.isFinite(t.y)).toBe(true);
    }
    expect(tangents([])).toEqual([]);
  });

  it('turns the tangent a quarter turn to the left, in y-down space', () => {
    expect(normal({ x: 1, y: 0 })).toEqual({ x: -0, y: 1 });
    expect(normal({ x: 0, y: 1 })).toEqual({ x: -1, y: 0 });
  });
});

describe('curvatures', () => {
  it('recovers 1/R on a sampled circle', () => {
    const R = 80;
    const circle = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * Math.PI * 2;
      return { x: Math.cos(a) * R, y: Math.sin(a) * R };
    });
    const k = curvatures(circle);
    for (let i = 1; i < k.length - 1; i++) expect(Math.abs(k[i])).toBeCloseTo(1 / R, 4);
  });

  it('is zero on a straight line and flips sign with the turn', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ];
    expect(curvatures(line)).toEqual([0, 0, 0]);

    const leftTurn = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }];
    const rightTurn = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: -10 }];
    expect(Math.sign(curvatures(leftTurn)[1])).toBe(-Math.sign(curvatures(rightTurn)[1]));
  });

  it('pins the ends to zero and never divides by a coincident triple', () => {
    const k = curvatures([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }]);
    expect(k).toEqual([0, 0, 0]);
    expect(curvatures([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toEqual([0, 0]);
  });
});
