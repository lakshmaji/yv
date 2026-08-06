import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BOUNDS,
  DINO_EXTENT,
  DINO_PALETTE_COUNT,
  DINO_SPECIES,
  DINO_TEMPO,
  dinoInsets,
  dinoShape,
  randomDino,
  randomDinos,
  type Dino,
  type DinoSpecies,
  type Rect,
} from './dino';
import { isValidColor } from './envColors';
import { pointInPolygon, type Pt } from './landscape/geometry';

const NAMES = ['Rexy', 'Bronte', 'Spike', 'Trixie', 'Dot', 'Nessa', 'a', ''];

/** Non-null placement inside the default bounds — the common case. */
function dino(name: string, opts = {}): Dino {
  const d = randomDino(name, opts);
  expect(d, `expected a dinosaur for "${name}"`).not.toBeNull();
  return d!;
}

describe('randomDino', () => {
  it('is fully determined by the name', () => {
    for (const name of NAMES) {
      expect(randomDino(name)).toEqual(randomDino(name));
    }
  });

  it('gives different names different animals', () => {
    const a = dino('Rexy');
    const b = dino('Bronte');
    expect({ ...a, name: '' }).not.toEqual({ ...b, name: '' });
  });

  it('distinguishes names that differ by one character', () => {
    const a = dino('Rexy');
    const b = dino('Rexz');
    expect([a.x, a.y]).not.toEqual([b.x, b.y]);
  });

  it('reports the name it was given', () => {
    expect(dino('Trixie').name).toBe('Trixie');
    expect(dino('').name).toBe('');
  });

  it('picks a known species and a valid palette', () => {
    for (const name of NAMES) {
      const d = dino(name);
      expect(DINO_SPECIES).toContain(d.species);
      for (const [key, value] of Object.entries(d.colors)) {
        expect(isValidColor(value), `${d.name}.${key} = ${value}`).toBe(true);
      }
    }
  });

  it('honours a forced species', () => {
    for (const species of DINO_SPECIES) {
      expect(dino('Rexy', { species }).species).toBe(species);
    }
  });

  it('stays inside the bounds it is given', () => {
    const bounds: Rect = { x: 500, y: 200, width: 120, height: 90 };
    for (const name of NAMES) {
      const d = dino(name, { bounds });
      expect(d.x).toBeGreaterThanOrEqual(bounds.x);
      expect(d.x).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(d.y).toBeGreaterThanOrEqual(bounds.y);
      expect(d.y).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
  });

  it('defaults to DEFAULT_BOUNDS', () => {
    for (const name of NAMES) {
      const d = dino(name);
      expect(d.x).toBeGreaterThanOrEqual(DEFAULT_BOUNDS.x);
      expect(d.x).toBeLessThanOrEqual(DEFAULT_BOUNDS.x + DEFAULT_BOUNDS.width);
      expect(d.y).toBeLessThanOrEqual(DEFAULT_BOUNDS.y + DEFAULT_BOUNDS.height);
    }
  });

  it('respects the allow predicate', () => {
    // A band down the middle: every placement must land in it.
    const allow = (p: Pt): boolean => p.x > 700 && p.x < 900;
    for (const name of NAMES) {
      const d = randomDino(name, { allow, attempts: 400 });
      if (!d) continue;
      expect(d.x).toBeGreaterThan(700);
      expect(d.x).toBeLessThan(900);
    }
  });

  it('returns null rather than cheating when nothing is allowed', () => {
    expect(randomDino('Rexy', { allow: () => false })).toBeNull();
  });

  it('keeps size within the requested range', () => {
    for (const name of NAMES) {
      const d = dino(name, { minSize: 40, maxSize: 60 });
      expect(d.size).toBeGreaterThanOrEqual(40);
      expect(d.size).toBeLessThan(60);
    }
  });

  it('faces both ways across a set of names', () => {
    const facings = new Set(NAMES.map((n) => dino(n).facing));
    expect(facings.size).toBe(2);
    for (const f of facings) expect([1, -1]).toContain(f);
  });

  it('moves the same animal with variant, without redressing it', () => {
    const a = dino('Rexy', { variant: 1 });
    const b = dino('Rexy', { variant: 2 });
    expect([a.x, a.y]).not.toEqual([b.x, b.y]);
    // Variant reshuffles the whole stream, so the look may change too — what
    // must hold is that it stays a valid, well-formed animal.
    expect(DINO_SPECIES).toContain(b.species);
    expect(dino('Rexy', { variant: 1 })).toEqual(a);
  });

  it('gives every animal markings and an animation phase', () => {
    for (const name of NAMES) {
      const d = dino(name);
      expect(d.spots.length).toBeGreaterThanOrEqual(3);
      for (const s of d.spots) expect(s.r).toBeGreaterThan(0);
      expect(d.phase).toBeGreaterThanOrEqual(0);
      expect(d.phase).toBeLessThan(1);
    }
  });
});

describe('randomDinos', () => {
  it('places a herd, spaced apart, sorted back to front', () => {
    const herd = randomDinos(NAMES, { minGap: 200 });
    expect(herd.length).toBeGreaterThan(1);
    const ys = herd.map((d) => d.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    for (let i = 0; i < herd.length; i++) {
      for (let j = i + 1; j < herd.length; j++) {
        expect(Math.hypot(herd[i].x - herd[j].x, herd[i].y - herd[j].y)).toBeGreaterThanOrEqual(200);
      }
    }
  });

  it('keeps each animal seeded by its own name', () => {
    const herd = randomDinos(['Rexy', 'Dot']);
    for (const d of herd) {
      // Placement is constrained by the herd, but identity is not.
      expect(d.species).toBe(randomDino(d.name)!.species);
      expect(d.colors).toEqual(randomDino(d.name)!.colors);
    }
  });

  it('is deterministic and drops what will not fit rather than overlapping', () => {
    expect(randomDinos(NAMES)).toEqual(randomDinos(NAMES));
    // An impossibly large gap means at most one animal can be placed.
    expect(randomDinos(NAMES, { minGap: 100_000 }).length).toBeLessThanOrEqual(1);
  });

  it('combines the caller predicate with its own spacing', () => {
    const coast: Pt[] = [
      { x: 100, y: 100 }, { x: 900, y: 100 }, { x: 900, y: 700 }, { x: 100, y: 700 },
    ];
    const herd = randomDinos(NAMES, { allow: (p) => pointInPolygon(p, coast), minGap: 120 });
    expect(herd.length).toBeGreaterThan(0);
    for (const d of herd) expect(pointInPolygon({ x: d.x, y: d.y }, coast)).toBe(true);
  });

  it('returns an empty herd for no names', () => {
    expect(randomDinos([])).toEqual([]);
  });

  it('gives every animal in a herd a different colour', () => {
    const herd = randomDinos(NAMES.slice(0, DINO_PALETTE_COUNT), { minGap: 60 });
    expect(herd.length).toBeGreaterThan(2);
    const bodies = new Set(herd.map((d) => d.colors.body));
    expect(bodies.size).toBe(herd.length);
    const indices = new Set(herd.map((d) => d.paletteIndex));
    expect(indices.size).toBe(herd.length);
  });

  it('keeps colours consistent with the palette index it reports', () => {
    for (const d of randomDinos(NAMES, { minGap: 60 })) {
      expect(d.paletteIndex).toBeGreaterThanOrEqual(0);
      expect(d.paletteIndex).toBeLessThan(DINO_PALETTE_COUNT);
      for (const value of Object.values(d.colors)) expect(isValidColor(value)).toBe(true);
    }
  });

  it('only repeats a colour once the herd outgrows the palette set', () => {
    const many = Array.from({ length: DINO_PALETTE_COUNT + 4 }, (_, i) => `dino-${i}`);
    const herd = randomDinos(many, { minGap: 40 });
    const bodies = new Set(herd.map((d) => d.colors.body));
    expect(bodies.size).toBe(Math.min(herd.length, DINO_PALETTE_COUNT));
  });

  it('can be told not to de-duplicate colours', () => {
    const herd = randomDinos(NAMES, { minGap: 60, distinctColors: false });
    for (const d of herd) {
      expect(d.paletteIndex).toBe(randomDino(d.name)!.paletteIndex);
    }
  });

  it('is still deterministic with colour de-duplication on', () => {
    expect(randomDinos(NAMES, { minGap: 60 })).toEqual(randomDinos(NAMES, { minGap: 60 }));
  });
});

describe('DINO_TEMPO', () => {
  it('covers every species with a sane cycle length', () => {
    for (const species of DINO_SPECIES) {
      const tempo = DINO_TEMPO[species];
      expect(tempo, species).toBeGreaterThan(1);
      expect(tempo, species).toBeLessThan(12);
    }
    expect(Object.keys(DINO_TEMPO).sort()).toEqual([...DINO_SPECIES].sort());
  });

  it('gives each species its own rhythm', () => {
    // A herd sharing one tempo reads as a single animated texture rather than
    // as individual animals, which is the whole reason this exists.
    const tempos = DINO_SPECIES.map((s) => DINO_TEMPO[s]);
    expect(new Set(tempos).size).toBe(tempos.length);
    // Non-harmonic: no pair may be a near-exact multiple, or they resynchronise.
    for (let i = 0; i < tempos.length; i++) {
      for (let j = i + 1; j < tempos.length; j++) {
        const ratio = Math.max(tempos[i], tempos[j]) / Math.min(tempos[i], tempos[j]);
        expect(Math.abs(ratio - Math.round(ratio)), `${tempos[i]}/${tempos[j]}`)
          .toBeGreaterThan(0.08);
      }
    }
  });
});

describe('dinoInsets / DINO_EXTENT', () => {
  it('scales with size', () => {
    const insets = dinoInsets(100);
    expect(insets.left).toBeCloseTo(DINO_EXTENT.left * 100, 6);
    expect(insets.top).toBeCloseTo(DINO_EXTENT.top * 100, 6);
    expect(insets.bottom).toBeLessThan(insets.top);
  });

  it('actually contains every species — the point of the constant', () => {
    // If a profile ever grows past the declared extent, a caller insetting by it
    // would still clip the animal at the container edge.
    for (const species of DINO_SPECIES) {
      for (const name of NAMES) {
        const d = { ...dino(name, { species }), x: 0, y: 0, size: 100 };
        for (const facing of [1, -1] as const) {
          const s = dinoShape({ ...d, facing });
          const paths = [
            s.body, s.belly, ...s.plates, ...s.legsBack, ...s.legsFront,
            ...s.arms, ...s.horns, s.frill ?? '', s.smile, ...s.growl,
          ];
          for (const path of paths) {
            const nums = (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
            for (let i = 0; i < nums.length; i += 2) {
              expect(nums[i], `${species} x`).toBeGreaterThanOrEqual(-DINO_EXTENT.left * 100);
              expect(nums[i], `${species} x`).toBeLessThanOrEqual(DINO_EXTENT.right * 100);
              expect(-nums[i + 1], `${species} v`).toBeLessThanOrEqual(DINO_EXTENT.top * 100);
              expect(nums[i + 1], `${species} v`).toBeLessThanOrEqual(DINO_EXTENT.bottom * 100);
            }
          }
          // The ground shadow is the lowest thing drawn.
          expect(s.shadow.cy + s.shadow.ry).toBeLessThanOrEqual(DINO_EXTENT.bottom * 100);
        }
      }
    }
  });
});

describe('dinoShape', () => {
  const all: Dino[] = DINO_SPECIES.flatMap((species: DinoSpecies) =>
    NAMES.map((n) => dino(n, { species })),
  );

  it('emits closed paths with no NaN', () => {
    for (const d of all) {
      const s = dinoShape(d);
      const closed = [s.body, s.belly, ...s.plates, ...s.legsBack, ...s.legsFront];
      for (const path of closed) {
        expect(path).not.toContain('NaN');
        expect(path.endsWith('Z')).toBe(true);
      }
      // The smile is an open stroke, so it must not close.
      expect(s.smile).not.toContain('NaN');
      expect(s.smile.endsWith('Z')).toBe(false);
      for (const optional of [s.frill, ...s.horns, ...s.arms]) {
        if (optional) expect(optional).not.toContain('NaN');
      }
    }
  });

  it('emits three growl arcs, open, growing outward from the mouth', () => {
    for (const d of all) {
      const s = dinoShape(d);
      expect(s.growl).toHaveLength(3);
      const spans: number[] = [];
      for (const arc of s.growl) {
        expect(arc).not.toContain('NaN');
        // Stroked, so they must stay open — a closed arc would fill as a wedge.
        expect(arc.endsWith('Z')).toBe(false);
        const nums = (arc.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
        const xs: number[] = [];
        const ys: number[] = [];
        for (let i = 0; i < nums.length; i += 2) { xs.push(nums[i]); ys.push(nums[i + 1]); }
        spans.push(Math.max(...ys) - Math.min(...ys));
      }
      // Each ring is wider than the one inside it, or they would not read as
      // a wave travelling outward.
      expect(spans[1]).toBeGreaterThan(spans[0]);
      expect(spans[2]).toBeGreaterThan(spans[1]);
    }
  });

  it('fans the arcs open as they travel, not just scales them up', () => {
    // Measured as angle about the mouth, so it is independent of radius: equal
    // angles would mean three nested copies of one shape — a logo, not a wave.
    for (const d of all) {
      const s = dinoShape(d);
      const angles = s.growl.map((arc) => {
        const nums = (arc.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
        const first = { x: nums[0], y: nums[1] };
        const last = { x: nums[nums.length - 2], y: nums[nums.length - 1] };
        const a0 = Math.atan2(first.y - s.growlOrigin.y, first.x - s.growlOrigin.x);
        const a1 = Math.atan2(last.y - s.growlOrigin.y, last.x - s.growlOrigin.x);
        let span = Math.abs(a1 - a0);
        if (span > Math.PI) span = 2 * Math.PI - span;
        return span;
      });
      expect(angles[1]).toBeGreaterThan(angles[0] + 0.1);
      expect(angles[2]).toBeGreaterThan(angles[1] + 0.1);
      // Still a forward cone, not a halo around the head.
      expect(angles[2]).toBeLessThan(Math.PI * 0.75);
    }
  });

  it('radiates from the mouth, on the face and forward of centre', () => {
    for (const species of DINO_SPECIES) {
      const d = { ...dino('Rexy', { species }), x: 0, y: 0, size: 100, facing: 1 as const };
      const s = dinoShape(d);
      expect(s.growlOrigin.x).toBeGreaterThan(0);
      // Level with the smile, which is where a mouth is.
      const lipNums = (s.smile.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      const lipYs: number[] = [];
      for (let i = 1; i < lipNums.length; i += 2) lipYs.push(lipNums[i]);
      expect(s.growlOrigin.y).toBeGreaterThanOrEqual(Math.min(...lipYs) - 1);
      expect(s.growlOrigin.y).toBeLessThanOrEqual(Math.max(...lipYs) + 1);
    }
  });

  it('puts the growl in front of the face, on whichever way it faces', () => {
    for (const species of DINO_SPECIES) {
      for (const facing of [1, -1] as const) {
        const d = { ...dino('Rexy', { species }), x: 0, y: 0, size: 100, facing };
        const s = dinoShape(d);
        const outer = (s.growl[2].match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
        const xs: number[] = [];
        for (let i = 0; i < outer.length; i += 2) xs.push(outer[i]);
        // Forward of the animal's centre, mirrored with facing.
        const tip = facing === 1 ? Math.max(...xs) : Math.min(...xs);
        expect(Math.sign(tip)).toBe(facing);
        expect(Math.abs(tip)).toBeGreaterThan(d.size * 0.5);
      }
    }
  });

  it('gives every species legs, a face and a shadow', () => {
    for (const d of all) {
      const s = dinoShape(d);
      const legs = s.legsBack.length + s.legsFront.length;
      expect(legs).toBeGreaterThanOrEqual(2);
      expect(s.legsFront.length).toBeGreaterThan(0);
      expect(s.toes).toHaveLength(s.legsFront.length);
      expect(s.eye.r).toBeGreaterThan(0);
      expect(s.glint.r).toBeGreaterThan(0);
      expect(s.glint.r).toBeLessThan(s.eye.r);
      expect(s.shadow.rx).toBeGreaterThan(s.shadow.ry);
    }
  });

  it('only gives the triceratops a frill and horns, and only the theropod arms', () => {
    for (const d of all) {
      const s = dinoShape(d);
      const horned = d.species === 'triceratops';
      expect(s.frill !== null).toBe(horned);
      expect(s.horns.length > 0).toBe(horned);
      if (horned) expect(s.horns).toHaveLength(2);
      expect(s.arms.length > 0).toBe(d.species === 'theropod');
    }
  });

  it('plates the species that should have them', () => {
    const plateCount = (species: DinoSpecies): number =>
      dinoShape(dino('Rexy', { species })).plates.length;
    expect(plateCount('stegosaur')).toBeGreaterThan(3);
    expect(plateCount('sauropod')).toBeGreaterThan(0);
    expect(plateCount('theropod')).toBeGreaterThan(0);
    expect(plateCount('triceratops')).toBe(0);
  });

  it('stands on its feet: nothing reaches below the ground point', () => {
    for (const d of all) {
      const s = dinoShape(d);
      const ys: number[] = [];
      for (const path of [s.body, s.belly, ...s.legsBack, ...s.legsFront, ...s.plates, ...s.arms]) {
        const nums = (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
        for (let i = 1; i < nums.length; i += 2) ys.push(nums[i]);
      }
      // A smoothed outline can overshoot its control points slightly, so allow a
      // small margin — but the figure must not hang far below its own feet.
      expect(Math.max(...ys)).toBeLessThanOrEqual(d.y + d.size * 0.06);
      expect(Math.min(...ys)).toBeGreaterThan(d.y - d.size * 1.6);
    }
  });

  it('mirrors when facing left', () => {
    const right = { ...dino('Rexy', { species: 'sauropod' }), x: 0, y: 0, facing: 1 as const };
    const left = { ...right, facing: -1 as const };
    const sr = dinoShape(right);
    const sl = dinoShape(left);
    expect(sl.body).not.toBe(sr.body);
    // The eye is forward of centre, so mirroring must flip its side.
    expect(Math.sign(sl.eye.cx)).toBe(-Math.sign(sr.eye.cx));
    // Height is unaffected by a horizontal mirror.
    expect(sl.eye.cy).toBeCloseTo(sr.eye.cy, 6);
  });

  it('scales linearly with size', () => {
    const small = { ...dino('Dot', { species: 'stegosaur' }), x: 0, y: 0, size: 50 };
    const big = { ...small, size: 100 };
    expect(dinoShape(big).eye.cx).toBeCloseTo(dinoShape(small).eye.cx * 2, 6);
    expect(dinoShape(big).eye.r).toBeCloseTo(dinoShape(small).eye.r * 2, 6);
  });

  it('is pure — repeated calls agree, including the randomised plates', () => {
    for (const d of all.slice(0, 8)) {
      expect(dinoShape(d)).toEqual(dinoShape(d));
    }
  });
});
