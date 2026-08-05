import { describe, it, expect } from 'vitest';
import { makeRng } from './rng';

describe('makeRng', () => {
  it('is deterministic for a given seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('diverges for different seeds', () => {
    const a = Array.from({ length: 10 }, makeRng(1).next);
    const b = Array.from({ length: 10 }, makeRng(2).next);
    expect(a).not.toEqual(b);
  });

  it('stays in [0, 1)', () => {
    const rng = makeRng(99);
    for (let i = 0; i < 500; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('accepts negative and fractional seeds', () => {
    for (const seed of [-7, 3.9, 0]) {
      const v = makeRng(seed).next();
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('range / int / pick / chance', () => {
  const rng = makeRng(4242);

  it('range stays within bounds', () => {
    for (let i = 0; i < 300; i++) {
      const v = rng.range(-5, 12);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(12);
    }
  });

  it('int is inclusive on both ends and only ever integral', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const v = rng.int(1, 4);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(4);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });

  it('pick only returns members of the list', () => {
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 100; i++) {
      expect(items).toContain(rng.pick(items));
    }
  });

  it('chance(0) is never and chance(1) is always', () => {
    for (let i = 0; i < 50; i++) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(1)).toBe(true);
    }
  });
});
