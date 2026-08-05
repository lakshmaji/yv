// Seeded pseudo-random numbers. The landscape generator must be reproducible —
// the same seed has to yield the same world on every render and on every
// machine — so nothing in generation may touch Math.random().

export interface Rng {
  /** Next value in [0, 1). */
  next(): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** True with probability p. */
  chance(p: number): boolean;
}

/**
 * mulberry32 — a 32-bit generator that is tiny, fast, and has good enough
 * distribution for scattering trees. Chosen over `sin`-hash tricks because
 * those differ subtly across JS engines, which would break the determinism
 * tests and make a saved seed mean different things in different builds.
 */
export function makeRng(seed: number): Rng {
  // Force to uint32 so a negative or fractional seed still gives a valid state.
  let state = Math.trunc(seed) >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
  };
}

/**
 * FNV-1a over a string, as a uint32 suitable for makeRng.
 *
 * Lets a caller seed from a name instead of a number, so "Rexy" is always the
 * same creature. Two names that differ by one character land in unrelated parts
 * of the sequence, which matters — a hash that clustered similar names would
 * give a herd of near-identical animals.
 */
export function hashText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

