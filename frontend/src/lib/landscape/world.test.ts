import { describe, it, expect } from 'vitest';
import { generateWorld, linePath, ringPath, worldBiomeKinds, MAX_TREES, WORLD_H, WORLD_W } from './world';
import { pointInPolygon, type Pt } from './geometry';
import { BIOME_KINDS, BIOME_RAMPS, LAND, biomeColor } from './palette';
import { peakShape, settlementShape, treeShape } from './shapes';
import { isValidColor } from '../envColors';

// A spread of seeds, so a property that only holds for one lucky world fails.
const SEEDS = [1, 7, 42, 1234, 20260806, 999999, 0];

describe('generateWorld determinism', () => {
  it('returns a deep-equal world for the same seed', () => {
    for (const seed of SEEDS) {
      expect(generateWorld(seed)).toEqual(generateWorld(seed));
    }
  });

  it('returns different worlds for different seeds', () => {
    expect(generateWorld(1)).not.toEqual(generateWorld(2));
  });

  it('records its own seed and canvas size', () => {
    const w = generateWorld(42);
    expect(w.seed).toBe(42);
    expect(w.width).toBe(WORLD_W);
    expect(w.height).toBe(WORLD_H);
  });
});

describe('generateWorld structure', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed}`, () => {
      const w = generateWorld(seed);

      it('has a closed coastline with enough vertices to look organic', () => {
        expect(w.coast.length).toBeGreaterThanOrEqual(24);
      });

      it('has biomes, each with terrace steps', () => {
        expect(w.biomes.length).toBeGreaterThanOrEqual(5);
        for (const b of w.biomes) {
          expect(BIOME_KINDS).toContain(b.kind);
          expect(b.region.length).toBeGreaterThan(8);
          expect(b.terraces.length).toBeGreaterThanOrEqual(2);
          for (const t of b.terraces) {
            expect(t).toHaveLength(b.region.length);
          }
        }
      });

      it('always includes the red-rock region', () => {
        expect(w.biomes.some((b) => b.kind === 'redrock')).toBe(true);
      });

      it('keeps every islet off the island', () => {
        for (const islet of w.islets) {
          for (const p of islet) {
            expect(pointInPolygon(p, w.coast)).toBe(false);
          }
        }
      });

      it('puts every tree on dry land, within the node budget', () => {
        expect(w.trees.length).toBeLessThanOrEqual(MAX_TREES);
        expect(w.trees.length).toBeGreaterThan(20);
        for (const t of w.trees) {
          expect(pointInPolygon({ x: t.x, y: t.y }, w.coast)).toBe(true);
          expect(t.sway).toBeGreaterThanOrEqual(0);
          expect(t.sway).toBeLessThan(1);
        }
      });

      it('sorts trees and peaks back-to-front', () => {
        const ys = w.trees.map((t) => t.y);
        expect(ys).toEqual([...ys].sort((a, b) => a - b));
        const py = w.peaks.map((p) => p.y);
        expect(py).toEqual([...py].sort((a, b) => a - b));
      });

      it('puts every peak on dry land and never snows on red rock', () => {
        expect(w.peaks.length).toBeGreaterThan(0);
        for (const p of w.peaks) {
          expect(pointInPolygon({ x: p.x, y: p.y }, w.coast)).toBe(true);
          expect(p.height).toBeGreaterThan(p.baseR);
          if (p.snow) expect(p.height).toBeGreaterThan(p.baseR * 2.2);
        }
      });

      it('runs the trunk river from inland to past the shoreline', () => {
        expect(w.rivers.length).toBeGreaterThanOrEqual(3);
        const trunk = w.rivers[0];
        expect(pointInPolygon(trunk.points[0], w.coast)).toBe(true);
        expect(pointInPolygon(trunk.points[trunk.points.length - 1], w.coast)).toBe(false);
      });

      it('keeps tributaries attached to the trunk', () => {
        const trunk = w.rivers[0].points;
        for (const trib of w.rivers.slice(1)) {
          const end = trib.points[trib.points.length - 1];
          expect(trunk.some((p) => p.x === end.x && p.y === end.y)).toBe(true);
        }
      });

      it('puts every lake on the island', () => {
        for (const lake of w.lakes) {
          expect(pointInPolygon(lake.center, w.coast)).toBe(true);
          expect(lake.radius).toBeGreaterThan(0);
        }
      });

      it('places settlements on land, spaced apart, with names', () => {
        expect(w.settlements.length).toBeGreaterThanOrEqual(2);
        for (const s of w.settlements) {
          expect(pointInPolygon({ x: s.x, y: s.y }, w.coast)).toBe(true);
          expect(s.name.length).toBeGreaterThan(3);
          expect(['hut', 'camp', 'ruin']).toContain(s.kind);
        }
        for (let i = 0; i < w.settlements.length; i++) {
          for (let j = i + 1; j < w.settlements.length; j++) {
            const a = w.settlements[i];
            const b = w.settlements[j];
            expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(120);
          }
        }
      });

      it('links the settlements with one trail per hop', () => {
        expect(w.trails).toHaveLength(Math.max(0, w.settlements.length - 1));
        for (const trail of w.trails) {
          expect(trail.length).toBeGreaterThanOrEqual(3);
        }
      });

      it('gives every cloud a drift loop and a head start into it', () => {
        expect(w.clouds.length).toBeGreaterThanOrEqual(4);
        for (const c of w.clouds) {
          expect(c.duration).toBeGreaterThan(0);
          expect(c.delay).toBeLessThanOrEqual(0);
          expect(c.opacity).toBeGreaterThan(0);
          expect(c.opacity).toBeLessThan(0.2);
        }
      });

      it('emits no NaN or infinity anywhere', () => {
        const walk = (value: unknown, path: string): void => {
          if (typeof value === 'number') {
            expect(Number.isFinite(value), `${path} = ${value}`).toBe(true);
            return;
          }
          if (Array.isArray(value)) {
            value.forEach((v, i) => walk(v, `${path}[${i}]`));
            return;
          }
          if (value && typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
          }
        };
        walk(w, 'world');
      });
    });
  }
});

describe('path helpers', () => {
  const w = generateWorld(20260806);

  it('closes the coastline and biome rings', () => {
    expect(ringPath(w.coast).endsWith('Z')).toBe(true);
    for (const b of w.biomes) expect(ringPath(b.region).endsWith('Z')).toBe(true);
  });

  it('leaves rivers and trails open', () => {
    for (const r of w.rivers) expect(linePath(r.points).endsWith('Z')).toBe(false);
    for (const t of w.trails) expect(linePath(t).endsWith('Z')).toBe(false);
  });

  it('never writes NaN into a path', () => {
    const all = [
      ringPath(w.coast),
      ...w.biomes.flatMap((b) => [ringPath(b.region), ...b.terraces.map(ringPath)]),
      ...w.rivers.map((r) => linePath(r.points)),
      ...w.lakes.map((l) => ringPath(l.ring)),
      ...w.trails.map(linePath),
    ];
    for (const d of all) expect(d).not.toContain('NaN');
  });
});

describe('shapes', () => {
  const w = generateWorld(7);

  it('builds a peak silhouette with a lit facet, and snow only when flagged', () => {
    for (const peak of w.peaks) {
      const s = peakShape(peak);
      expect(s.body).not.toContain('NaN');
      expect(s.lit).not.toContain('NaN');
      expect(s.base).not.toContain('NaN');
      expect(s.body.endsWith('Z')).toBe(true);
      expect(s.snow === null).toBe(!peak.snow);
      if (s.snow) expect(s.snow).not.toContain('NaN');
    }
  });

  it('builds a trunk and two canopy tiers per tree', () => {
    for (const tree of w.trees) {
      const s = treeShape(tree);
      for (const d of [s.trunk, s.canopyLower, s.canopyUpper]) {
        expect(d).not.toContain('NaN');
        expect(d.endsWith('Z')).toBe(true);
      }
    }
  });

  it('gives huts a roof and ruins none', () => {
    const at = (kind: 'hut' | 'camp' | 'ruin') => settlementShape({ x: 10, y: 20, kind, name: 'x' });
    expect(at('hut').roof).not.toBeNull();
    expect(at('camp').roof).toBeNull();
    expect(at('ruin').roof).toBeNull();
    // A ruin is two broken columns, so its body is two subpaths.
    expect(at('ruin').body.match(/Z/g)).toHaveLength(2);
  });
});

describe('palette', () => {
  it('is all valid hex, by the same rule the env colours use', () => {
    for (const [key, value] of Object.entries(LAND)) {
      expect(isValidColor(value), `${key} = ${value}`).toBe(true);
    }
  });

  it('gives every biome a three-stop ramp of valid colours', () => {
    for (const kind of BIOME_KINDS) {
      const ramp = BIOME_RAMPS[kind];
      expect(ramp).toHaveLength(3);
      for (const c of ramp) expect(isValidColor(c)).toBe(true);
    }
  });

  it('clamps the ramp index instead of wrapping', () => {
    expect(biomeColor('grass', -3)).toBe(BIOME_RAMPS.grass[0]);
    expect(biomeColor('grass', 99)).toBe(BIOME_RAMPS.grass[2]);
  });
});

describe('worldBiomeKinds', () => {
  it('lists present kinds only, in canonical order', () => {
    const w = generateWorld(42);
    const kinds = worldBiomeKinds(w);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toEqual(BIOME_KINDS.filter((k) => kinds.includes(k)));
    for (const k of kinds) {
      expect(w.biomes.some((b) => b.kind === k)).toBe(true);
    }
  });
});

// Guards the fixed canvas the SVG viewBox depends on.
describe('world canvas', () => {
  it('is 16:9', () => {
    expect(WORLD_W / WORLD_H).toBeCloseTo(16 / 9, 5);
  });

  it('keeps the coastline inside the canvas with sea on every side', () => {
    for (const seed of SEEDS) {
      const coast: Pt[] = generateWorld(seed).coast;
      for (const p of coast) {
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(WORLD_W);
        expect(p.y).toBeGreaterThan(0);
        expect(p.y).toBeLessThan(WORLD_H);
      }
    }
  });
});
