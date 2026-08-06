import { describe, it, expect } from 'vitest';
import { insetRect, quantizeRect, visibleViewBox, type Rect } from './viewbox';

const VIEW = { width: 1600, height: 900 };

describe('visibleViewBox', () => {
  it('shows the whole viewBox when the aspect ratios match', () => {
    for (const container of [{ width: 1600, height: 900 }, { width: 800, height: 450 }]) {
      expect(visibleViewBox(VIEW, container)).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
    }
  });

  it('crops the sides when the container is relatively taller', () => {
    // Square container: slice scales to cover, so height fills and width is cut.
    const r = visibleViewBox(VIEW, { width: 900, height: 900 });
    expect(r.height).toBe(900);
    expect(r.width).toBe(900);
    // xMidYMid splits the crop evenly.
    expect(r.x).toBe(350);
    expect(r.y).toBe(0);
  });

  it('crops top and bottom when the container is relatively wider', () => {
    const r = visibleViewBox(VIEW, { width: 3200, height: 900 });
    expect(r.width).toBe(1600);
    expect(r.height).toBe(450);
    expect(r.x).toBe(0);
    expect(r.y).toBe(225);
  });

  it('is centred, and never larger than the viewBox', () => {
    const containers = [
      { width: 100, height: 1000 }, { width: 1000, height: 100 },
      { width: 1, height: 1 }, { width: 2400, height: 1000 },
    ];
    for (const container of containers) {
      const r = visibleViewBox(VIEW, container);
      expect(r.width).toBeLessThanOrEqual(VIEW.width);
      expect(r.height).toBeLessThanOrEqual(VIEW.height);
      expect(r.x + r.width / 2).toBeCloseTo(VIEW.width / 2, 6);
      expect(r.y + r.height / 2).toBeCloseTo(VIEW.height / 2, 6);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('falls back to the full viewBox before the first layout pass', () => {
    for (const container of [{ width: 0, height: 0 }, { width: 500, height: 0 }, { width: NaN, height: 10 }]) {
      expect(visibleViewBox(VIEW, container)).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
    }
  });

  it('degrades safely for a degenerate viewBox', () => {
    expect(visibleViewBox({ width: 0, height: 0 }, { width: 10, height: 10 }))
      .toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('insetRect', () => {
  const base: Rect = { x: 10, y: 20, width: 100, height: 80 };

  it('shrinks on each named side', () => {
    expect(insetRect(base, { left: 5, right: 5, top: 10, bottom: 10 }))
      .toEqual({ x: 15, y: 30, width: 90, height: 60 });
  });

  it('treats omitted sides as zero', () => {
    expect(insetRect(base, { left: 10 })).toEqual({ x: 20, y: 20, width: 90, height: 80 });
    expect(insetRect(base, {})).toEqual(base);
  });

  it('collapses to zero rather than going negative', () => {
    const r = insetRect(base, { left: 500, right: 500, top: 500, bottom: 500 });
    expect(r.width).toBe(0);
    expect(r.height).toBe(0);
  });
});

describe('quantizeRect', () => {
  it('snaps every edge inward', () => {
    // x 37→40, right 388→360, y 12→40, bottom 101→80.
    expect(quantizeRect({ x: 37, y: 12, width: 351, height: 89 }, 40))
      .toEqual({ x: 40, y: 40, width: 320, height: 40 });
  });

  it('never grows past the rect it was given', () => {
    // The invariant that matters: these bounds exist to keep things on screen,
    // so rounding must not push an edge outward. Rounding origin and size
    // independently does exactly that, and clipped a dinosaur off the panel.
    const rects: Rect[] = [
      { x: 145.5, y: 0, width: 1309, height: 900 },
      { x: 0, y: 225, width: 1600, height: 450 },
      { x: 3.2, y: 7.9, width: 111.4, height: 62.5 },
      { x: 39.9, y: 0.1, width: 80.2, height: 79.8 },
    ];
    for (const r of rects) {
      for (const step of [10, 25, 40, 64]) {
        const q = quantizeRect(r, step);
        expect(q.x).toBeGreaterThanOrEqual(r.x);
        expect(q.y).toBeGreaterThanOrEqual(r.y);
        expect(q.x + q.width).toBeLessThanOrEqual(r.x + r.width);
        expect(q.y + q.height).toBeLessThanOrEqual(r.y + r.height);
        expect(q.width).toBeGreaterThanOrEqual(0);
        expect(q.height).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('collapses rather than inverting when the rect is thinner than a step', () => {
    const q = quantizeRect({ x: 41, y: 41, width: 10, height: 10 }, 40);
    expect(q.width).toBe(0);
    expect(q.height).toBe(0);
  });

  it('leaves an already-aligned rect alone', () => {
    const r: Rect = { x: 80, y: 40, width: 400, height: 200 };
    expect(quantizeRect(r, 40)).toEqual(r);
  });

  it('absorbs small changes — the point of it', () => {
    const a = quantizeRect({ x: 84, y: 118, width: 486, height: 284 }, 40);
    const b = quantizeRect({ x: 87, y: 115, width: 490, height: 287 }, 40);
    expect(a).toEqual(b);
  });

  it('still moves when a value crosses a step boundary', () => {
    // Damping is not elimination: a drag that crosses a grid line shifts the
    // result by a whole step. That is the intended trade — one change per 40px
    // instead of one per pixel.
    expect(quantizeRect({ x: 79, y: 0, width: 400, height: 400 }, 40).x).toBe(80);
    expect(quantizeRect({ x: 81, y: 0, width: 400, height: 400 }, 40).x).toBe(120);
  });

  it('is a no-op for a non-positive step', () => {
    const r: Rect = { x: 1.5, y: 2.5, width: 3.5, height: 4.5 };
    expect(quantizeRect(r, 0)).toEqual(r);
    expect(quantizeRect(r, -5)).toEqual(r);
  });
});
