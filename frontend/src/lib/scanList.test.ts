import { describe, it, expect } from 'vitest';
import { defaultSelection, needsDecision, ordered, usable } from './scanList';
import type { ScanHit } from '../types';

function hit(over: Partial<ScanHit> = {}): ScanHit {
  return {
    path: '/dev/app/yv.yaml',
    dir: '/dev/app',
    hash: 'h1',
    project: { id: 'app', name: 'App', workingDir: '/dev/app', groups: [], commands: [] },
    exists: false,
    ...over,
  };
}

describe('usable', () => {
  it('accepts a file that parsed', () => expect(usable(hit())).toBe(true));
  it('rejects one that did not', () => expect(usable(hit({ error: 'cannot parse' }))).toBe(false));
});

describe('needsDecision', () => {
  const cases: [string, ScanHit, boolean][] = [
    ['a new file', hit(), true],
    ['a changed file', hit({ exists: true }), true],
    // The regression this guards: an identical file was listed as though it
    // still needed importing, so a finished import looked like it had failed.
    ['an identical file already imported', hit({ unchanged: true }), false],
    ['an identical file that was skipped', hit({ exists: true, unchanged: true }), false],
    // A broken file is still a decision — its author needs to know.
    ['a broken file', hit({ error: 'cannot parse' }), true],
  ];
  for (const [name, h, want] of cases) {
    it(`${name} -> ${want}`, () => expect(needsDecision(h)).toBe(want));
  }
});

describe('ordered', () => {
  it('puts new first, then replacements, then broken', () => {
    const got = ordered([
      hit({ path: '/broken', error: 'nope' }),
      hit({ path: '/replace', exists: true }),
      hit({ path: '/new' }),
    ]);
    expect(got.map((h) => h.path)).toEqual(['/new', '/replace', '/broken']);
  });

  it('does not mutate its input', () => {
    const input = [hit({ path: '/b', exists: true }), hit({ path: '/a' })];
    ordered(input);
    expect(input.map((h) => h.path)).toEqual(['/b', '/a']);
  });
});

describe('defaultSelection', () => {
  it('ticks new projects', () => {
    expect([...defaultSelection([hit({ path: '/new' })])]).toEqual(['/new']);
  });

  // Eighteen repositories must not arrive as eighteen pre-armed overwrites.
  it('leaves replacements unticked', () => {
    expect(defaultSelection([hit({ path: '/r', exists: true })]).size).toBe(0);
  });

  it('leaves unchanged and broken files unticked', () => {
    const sel = defaultSelection([
      hit({ path: '/same', unchanged: true }),
      hit({ path: '/bad', error: 'cannot parse' }),
    ]);
    expect(sel.size).toBe(0);
  });

  it('picks only the new ones out of a mixed scan', () => {
    const sel = defaultSelection([
      hit({ path: '/new1' }),
      hit({ path: '/new2' }),
      hit({ path: '/replace', exists: true }),
      hit({ path: '/same', unchanged: true }),
      hit({ path: '/bad', error: 'x' }),
    ]);
    expect([...sel].sort()).toEqual(['/new1', '/new2']);
  });
});
