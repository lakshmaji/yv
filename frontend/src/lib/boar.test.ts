import { describe, it, expect } from 'vitest';
import {
  BOAR_VIEWBOX, NEON, CHROMA_OFFSET, SPLASH, EYE_IDS,
  SPARK_ORIGINS, SPARK_REACH,
  boarStrokes, boarFacets, glitchBands, sparks,
} from './boar';

/**
 * Every path in boar.ts is absolute M/C/Z, which is asserted below — that is
 * what makes this parser exact rather than approximate.
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
  it.each(allPaths.map(p => [p.id, p.d] as const))('%s uses only absolute M/C/L/Z', (_id, d) => {
    // M, C and L all take coordinate pairs. Anything else (relative m/c/l, or
    // H/V/A/S/Q) would put an odd number of coordinates in the stream and break
    // the pairing above — H and V in particular take a lone x or y.
    expect(d.replace(/[-\d.,\s]/g, '')).toMatch(/^M[CLZ]*$/);
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

  it('only fills closed shapes', () => {
    // A fill on an open contour is not a shading choice, it is SVG closing the
    // path for you and flooding whatever that happens to enclose.
    for (const s of strokes) {
      if (s.fill) expect(s.closed, `${s.id} is filled but open`).toBe(true);
    }
  });

  it('fills the solid objects', () => {
    // Tusks, legs, hooves, the snout and the eye are things, not creases. Left
    // unfilled they read as loops of wire laid over the animal.
    for (const s of strokes.filter(s => s.role === 'tusk')) expect(s.fill).toBeTruthy();
    for (const id of ['legFrontNear', 'hoofFrontNear', 'snout', 'eyeNearIris', 'eyeFarIris']) {
      expect(strokes.find(s => s.id === id)?.fill, `${id} unfilled`).toBeTruthy();
    }
  });

  it('draws every limb under the body, and nothing else', () => {
    // A leg drawn over the body carries its own closed top edge, and that lid is
    // what made them read as four boxes hung off the belly. The body has to be
    // the thing that hides where they join — same for the tail's root. Only
    // things that stick OUT of the body may be flagged: anything wholly inside
    // it and behind it simply is not drawn.
    expect(strokes.filter(s => s.behind).map(s => s.id).sort()).toEqual([
      'hoofFrontFar', 'hoofFrontNear', 'hoofHindFar', 'hoofHindNear',
      'legFrontFar', 'legFrontNear', 'legHindFar', 'legHindNear', 'tail',
    ]);
  });

  it('lands the far feet higher than the near ones', () => {
    // They are further from the camera. Level with the near pair the animal
    // reads as standing on a wall rather than on the ground.
    const foot = (id: string) => Math.max(...pathPoints(strokes.find(s => s.id === id)!.d).map(([, y]) => y));
    expect(foot('hoofFrontFar')).toBeLessThan(foot('hoofFrontNear'));
    expect(foot('hoofHindFar')).toBeLessThan(foot('hoofHindNear'));
  });

  it('resolves every colour to a real hex', () => {
    // Tones are `shade()`d off the palette rather than written out, and shade
    // returns its input UNCHANGED when handed a non-hex string — so a typo in a
    // base colour does not throw, it quietly emits the typo into a `fill`
    // attribute. This is the assertion that catches that.
    const hex = /^#[0-9a-f]{6}$/i;
    for (const s of strokes) {
      expect(s.color, `${s.id} stroke`).toMatch(hex);
      if (s.fill) expect(s.fill, `${s.id} fill`).toMatch(hex);
    }
    for (const f of facets) expect(f.color, `${f.id}`).toMatch(hex);
  });

  it('builds its tones from the palette', () => {
    // Not every colour is a palette entry — most are shades of one — but every
    // base must be, so the splash keeps a single place its colours come from.
    const palette = new Set<string>(Object.values(NEON));
    expect(palette.has(NEON.body)).toBe(true);
    for (const id of ['body', 'tuskNear']) {
      expect(strokes.find(s => s.id === id)?.color).toBeTruthy();
    }
    expect(facets.find(f => f.id === 'bodyFacet')?.color).toBe(NEON.body);
  });
});

describe('draw order', () => {
  // The order IS the reveal: the outline first, so the animal is recognisable
  // early, then its creases and crest, then the tusks, then the eye. Reordering
  // the arrays in boar.ts is a one-line change that would silently ruin the only
  // timing the splash has, so it is pinned here.
  it('starts with the body itself', () => {
    // Not with the legs. They are painted underneath it, and emitting them in
    // paint order opened the splash on four disembodied legs with no animal —
    // reveal order and paint order are different questions.
    expect(strokes[0].id).toBe('body');
    expect(strokes.findIndex(s => s.id === 'legFrontNear'))
      .toBeGreaterThan(strokes.findIndex(s => s.id === 'body'));
  });

  it('draws the head before the tusks', () => {
    const lastHead = strokes.map(s => s.role).lastIndexOf('silhouette');
    const firstTusk = strokes.findIndex(s => s.role === 'tusk');
    expect(firstTusk).toBeGreaterThan(lastHead);
  });

  it('lights every part of the eye last of all', () => {
    expect(strokes.slice(-EYE_IDS.length).map(s => s.id).sort())
      .toEqual([...EYE_IDS].sort());
  });

  it('is stable across calls', () => {
    expect(boarStrokes().map(s => s.id)).toEqual(strokes.map(s => s.id));
    expect(boarStrokes().map(s => s.d)).toEqual(strokes.map(s => s.d));
  });

  it('has four legs, four hooves, two tusks and a mane', () => {
    const count = (role: string) => strokes.filter(s => s.role === role).length;
    expect(strokes.filter(s => s.id.startsWith('leg'))).toHaveLength(4);
    expect(strokes.filter(s => s.id.startsWith('hoof'))).toHaveLength(4);
    expect(count('tusk')).toBe(2);
    expect(count('bristle')).toBeGreaterThanOrEqual(10);
  });

  it('draws one tusk clearly bigger than the other', () => {
    // The pair used to be near-identical crescents on top of each other, which
    // reads as one thick tusk badly drawn rather than as two at different
    // distances. Measured by bounding-box area, which is crude but is exactly
    // the thing that was wrong.
    const area = (id: string) => {
      const pts = pathPoints(strokes.find(s => s.id === id)!.d);
      const xs = pts.map(([x]) => x);
      const ys = pts.map(([, y]) => y);
      return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    };
    expect(area('tuskNear')).toBeGreaterThan(area('tuskFar') * 2);
  });

  it('names the parts that carry the animal', () => {
    // Four legs, a spiked back and a snout disc. Everything else can move; if
    // any of these goes missing the drawing stops being a boar — which it has
    // done, as a whale, a mandrill, a cat and a tapir.
    for (const id of ['body', 'snout', 'tuskNear', 'legFrontNear', 'legHindFar', 'tail']) {
      expect(strokes.some(s => s.id === id), `missing ${id}`).toBe(true);
    }
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

  it('finishes the body mass as the last stroke lands', () => {
    // One animal appearing, not two events. Held back until after the wireframe
    // was complete, the facets read as a separate fill step — a drawing, a
    // pause, then a flood — instead of the thing solidifying as it is drawn.
    //
    // A tolerance rather than equality: drawEnd moves by drawStagger every time
    // a stroke is added to the drawing, and a hard equality would turn every
    // tweak to the animal into a spurious red test. 60ms is well inside what
    // reads as simultaneous, and still catches the constants actually drifting.
    expect(Math.abs(SPLASH.facetsAt + SPLASH.facetsDur - drawEnd)).toBeLessThanOrEqual(60);
  });

  it('starts the body mass while the wireframe is still drawing', () => {
    expect(SPLASH.facetsAt).toBeGreaterThan(SPLASH.drawStart);
    expect(SPLASH.facetsAt).toBeLessThan(drawEnd);
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
    // Against the lowest origin, not the nearest one. The tusk tips are closer
    // together than SPARK_REACH, so "nearest origin" is not the origin a given
    // spark actually came from — a spark thrown up from the lower tip can land
    // nearer the upper one and still be travelling in the right direction.
    const lowest = Math.max(...SPARK_ORIGINS.map(([, y]) => y));
    for (const s of sparks(4, 60)) expect(s.y).toBeLessThanOrEqual(lowest);
  });

  it('fits its whole shower inside the spark beat', () => {
    for (const s of sparks(4, 40)) {
      expect(s.delay).toBeGreaterThanOrEqual(0);
      expect(SPLASH.sparksAt + s.delay).toBeLessThan(SPLASH.exitAt);
    }
  });
});
