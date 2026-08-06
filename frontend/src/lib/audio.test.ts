import { describe, expect, it } from 'vitest';
import { addClips, clipDir, clipForName, clipLabel, SESSION_SALT } from './audio';

// Only the pure half is exercised here: vitest runs in the node environment, so
// Audio and the Wails bridge do not exist. playClip is verified by hand in the app.

const POOL = ['/clips/roar.mp3', '/clips/growl.wav', '/clips/bellow.m4a'];
const NAMES = ['Rexy', 'Bronte', 'Spike', 'Trixie', 'Dot', 'Nessa'];

describe('clipForName', () => {
  it('returns null for an empty pool', () => {
    expect(clipForName('Rexy', [], 1)).toBeNull();
  });

  it('always returns a member of the pool', () => {
    for (const name of NAMES) {
      expect(POOL).toContain(clipForName(name, POOL, 7));
    }
  });

  it('is stable for the same name and salt — a second click replays the same clip', () => {
    const first = clipForName('Rexy', POOL, 42);
    for (let i = 0; i < 20; i++) {
      expect(clipForName('Rexy', POOL, 42)).toBe(first);
    }
  });

  it('a single-clip pool always yields that clip', () => {
    expect(clipForName('Rexy', ['/only.mp3'], 3)).toBe('/only.mp3');
    expect(clipForName('Bronte', ['/only.mp3'], 999)).toBe('/only.mp3');
  });

  it('gives at least some dinosaurs different voices', () => {
    const assigned = new Set(NAMES.map((n) => clipForName(n, POOL, 1)));
    expect(assigned.size).toBeGreaterThan(1);
  });

  it('reshuffles across salts — a new session should not sound identical', () => {
    // Any single name can coincide across two salts, so compare the herd's whole
    // assignment rather than one animal.
    const shape = (salt: number) => NAMES.map((n) => clipForName(n, POOL, salt)).join('|');
    const differing = [2, 3, 4, 5, 6, 7, 8, 9].filter((s) => shape(s) !== shape(1));
    expect(differing.length).toBeGreaterThan(0);
  });

  it('spreads a herd across a large pool rather than clustering on one clip', () => {
    const pool = Array.from({ length: 8 }, (_, i) => `/clip-${i}.mp3`);
    const names = Array.from({ length: 60 }, (_, i) => `Dino-${i}`);
    const used = new Set(names.map((n) => clipForName(n, pool, 11)));
    expect(used.size).toBeGreaterThanOrEqual(6);
  });

  it('handles a fractional or negative salt without falling out of the pool', () => {
    expect(POOL).toContain(clipForName('Rexy', POOL, -12.7));
  });
});

describe('SESSION_SALT', () => {
  it('is a uint32', () => {
    expect(Number.isInteger(SESSION_SALT)).toBe(true);
    expect(SESSION_SALT).toBeGreaterThanOrEqual(0);
    expect(SESSION_SALT).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('clipLabel', () => {
  const cases: Array<[string, string]> = [
    ['/Users/me/clips/roar.mp3', 'roar.mp3'],
    ['/roar.mp3', 'roar.mp3'],
    ['roar.mp3', 'roar.mp3'],
    ['/Users/me/my clips/t-rex growl.wav', 't-rex growl.wav'],
    ['C:\\Sounds\\roar.mp3', 'roar.mp3'],
    ['/trailing/slash/', 'slash'],
    ['', ''],
  ];

  for (const [input, want] of cases) {
    it(`${input || '(empty)'} → ${want || '(empty)'}`, () => {
      expect(clipLabel(input)).toBe(want);
    });
  }
});

describe('clipDir', () => {
  const cases: Array<[string, string]> = [
    ['/Users/me/clips/roar.mp3', '/Users/me/clips'],
    ['/roar.mp3', ''], // at the root there is no folder line worth showing
    ['roar.mp3', ''],
    ['C:\\Sounds\\roar.mp3', 'C:\\Sounds'],
    ['relative/clips/roar.mp3', 'relative/clips'],
    ['', ''],
  ];

  for (const [input, want] of cases) {
    it(`${input || '(empty)'} → ${want || '(empty)'}`, () => {
      expect(clipDir(input)).toBe(want);
    });
  }
});

describe('addClips', () => {
  const cases: Array<{ name: string; existing: string[]; incoming: string[]; want: string[] }> = [
    { name: 'appends to an empty pool', existing: [], incoming: ['/a.mp3'], want: ['/a.mp3'] },
    {
      name: 'keeps the order things were added in',
      existing: ['/b.mp3'],
      incoming: ['/a.mp3', '/c.mp3'],
      want: ['/b.mp3', '/a.mp3', '/c.mp3'],
    },
    {
      name: 'picking the same file twice does not double it',
      existing: ['/a.mp3'],
      incoming: ['/a.mp3'],
      want: ['/a.mp3'],
    },
    {
      name: 'duplicates within one pick collapse',
      existing: [],
      incoming: ['/a.mp3', '/a.mp3'],
      want: ['/a.mp3'],
    },
    { name: 'blanks are dropped', existing: [], incoming: ['', '  '], want: [] },
    { name: 'paths are trimmed', existing: [], incoming: ['  /a.mp3 '], want: ['/a.mp3'] },
    { name: 'nothing picked leaves the pool alone', existing: ['/a.mp3'], incoming: [], want: ['/a.mp3'] },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      expect(addClips(tc.existing, tc.incoming)).toEqual(tc.want);
    });
  }

  it('does not mutate the pool it was given', () => {
    const existing = ['/a.mp3'];
    addClips(existing, ['/b.mp3']);
    expect(existing).toEqual(['/a.mp3']);
  });
});
