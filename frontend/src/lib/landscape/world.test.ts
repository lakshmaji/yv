import { describe, it, expect } from 'vitest';
import {
  generateWorld, linePath, openGround, ringPath, sceneryOrder, worldBiomeKinds,
  MAX_CRAG, MAX_TREES, RIDGE_STEPS, WORLD_H, WORLD_W,
} from './world';
import { pointInPolygon, type Pt } from './geometry';
import { riverRibbon } from './river';
import {
  BIOME_KINDS, BIOME_RAMPS, GREY_ROCK, LAND, RED_ROCK, biomeColor, rockRamp, shade,
} from './palette';
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

      it('puts every peak on dry land, with a plausible profile', () => {
        expect(w.peaks.length).toBeGreaterThan(0);
        for (const p of w.peaks) {
          expect(pointInPolygon({ x: p.x, y: p.y }, w.coast)).toBe(true);
          expect(p.height).toBeGreaterThan(p.baseR * 0.7);
          expect(p.ridgeL).toHaveLength(RIDGE_STEPS);
          expect(p.ridgeR).toHaveLength(RIDGE_STEPS);
          expect(p.tone).toBeGreaterThanOrEqual(-1);
          expect(p.tone).toBeLessThanOrEqual(1);
          expect(p.snowline).toBeGreaterThan(0);
          expect(p.snowline).toBeLessThan(1);
          expect(p.scree.length).toBeGreaterThanOrEqual(2);
        }
      });

      it('never snows on red rock', () => {
        for (const p of w.peaks) {
          if (p.red) expect(p.snow).toBe(false);
          if (p.snow) expect(p.height).toBeGreaterThan(p.baseR * 2);
        }
      });

      it('grows both grey and red mountains', () => {
        expect(w.peaks.some((p) => p.red)).toBe(true);
        expect(w.peaks.some((p) => !p.red)).toBe(true);
      });

      it('varies mountain scale rather than repeating one silhouette', () => {
        const ratios = w.peaks.map((p) => p.height / p.baseR);
        expect(Math.max(...ratios) - Math.min(...ratios)).toBeGreaterThan(0.5);
        // Every ridge is its own; identical jitter across peaks would mean the
        // generator stopped advancing the stream.
        const fingerprints = new Set(w.peaks.map((p) => p.ridgeL.join(',')));
        expect(fingerprints.size).toBe(w.peaks.length);
      });

      it('always gives the island a mountain-bearing biome', () => {
        expect(w.biomes.some((b) => b.kind === 'highland' || b.kind === 'snowfield')).toBe(true);
      });

      it('keeps shoulders subordinate to the main summit', () => {
        for (const p of w.peaks) {
          for (const s of p.shoulders) {
            expect([-1, 1]).toContain(s.side);
            expect(s.h).toBeLessThan(1);
            expect(s.at).toBeGreaterThan(0);
            expect(s.at).toBeLessThan(1);
          }
        }
      });

      it('runs the trunk river from inland to past the shoreline', () => {
        expect(w.rivers.length).toBeGreaterThanOrEqual(3);
        const trunk = w.rivers[0];
        expect(pointInPolygon(trunk.points[0], w.coast)).toBe(true);
        expect(pointInPolygon(trunk.points[trunk.points.length - 1], w.coast)).toBe(false);
      });

      it('widens every river downstream, peaking at exactly its stated width', () => {
        for (const river of w.rivers) {
          expect(river.widths).toHaveLength(river.points.length);
          for (const width of river.widths) expect(width).toBeGreaterThan(0);
          // Exact, not approximate: `width` is the clearance radius `waterDiscs`
          // reserves, so the peak is assigned literally rather than computed. If the
          // maximum could drift above it, the reserve would grow with the estuary
          // flare and the tree line would retreat along the whole course.
          expect(Math.max(...river.widths)).toBe(river.width);
          expect(river.widths[river.widths.length - 1]).toBeGreaterThan(river.widths[0]);
        }
      });

      it('steps the trunk up at every confluence', () => {
        const trunk = w.rivers[0];
        for (const trib of w.rivers.slice(1)) {
          const joinAt = trunk.points.findIndex(
            (p) => p.x === trib.points[2].x && p.y === trib.points[2].y,
          );
          expect(joinAt).toBeGreaterThan(0);
          // Below a junction the trunk carries the tributary's water too, and the
          // step is the only cue that says the two rivers became one.
          expect(trunk.widths[joinAt]).toBeGreaterThan(trunk.widths[joinAt - 1]);
          // And a tributary never out-widths the trunk it joins, or the confluence
          // reads as two rivers crossing.
          expect(trib.width).toBeLessThanOrEqual(trunk.widths[joinAt]);
        }
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
      ...w.rivers.flatMap((r) => {
        const ribbon = riverRibbon(r);
        return [ribbon.bank, ribbon.body, ribbon.shoal, ...ribbon.streaks.map((s) => s.d)];
      }),
      ...w.lakes.map((l) => ringPath(l.ring)),
      ...w.trails.map(linePath),
    ];
    for (const d of all) expect(d).not.toContain('NaN');
  });
});

describe('shapes', () => {
  const w = generateWorld(7);

  it('builds two facets and a crease for every mountain, with no NaN', () => {
    for (const peak of w.peaks) {
      const s = peakShape(peak);
      for (const d of [s.body, s.outline, s.lit, s.shade, s.crease]) {
        expect(d).not.toContain('NaN');
        expect(d.length).toBeGreaterThan(0);
      }
      expect(s.body.endsWith('Z')).toBe(true);
      expect(s.lit.endsWith('Z')).toBe(true);
      expect(s.shade.endsWith('Z')).toBe(true);
      expect(s.crease.startsWith('M')).toBe(true);
      // The outline is the rim only: open, so stroking it leaves the base free.
      expect(s.outline.startsWith('M')).toBe(true);
      expect(s.outline.endsWith('Z')).toBe(false);
      expect(s.shadow.rx).toBeGreaterThan(0);
      expect(s.shadow.ry).toBeGreaterThan(0);
      // Cast down-right, away from the light.
      expect(s.shadow.cx).toBeGreaterThan(peak.x);
      expect(s.shadow.cy).toBeGreaterThan(peak.y);
      expect(s.scree).toHaveLength(peak.scree.length);
      for (const block of s.scree) expect(block.r).toBeGreaterThan(0);
    }
  });

  it('keeps every silhouette a function of height, left to right', () => {
    // The one invariant that must hold: x runs monotonically from the left base
    // corner, over the summit, to the right one. Break it and the outline
    // crosses itself and the mountain renders as shattered glass.
    for (const peak of w.peaks) {
      const nums = (peakShape(peak).body.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      const xs: number[] = [];
      for (let i = 0; i < nums.length; i += 2) xs.push(nums[i]);
      for (let i = 1; i < xs.length; i++) {
        expect(xs[i], `peak at ${peak.x},${peak.y} vertex ${i}`).toBeGreaterThanOrEqual(xs[i - 1]);
      }
    }
  });

  it('gives each summit asymmetric flanks, so no two read alike', () => {
    for (const peak of w.peaks) {
      expect(Math.abs(peak.bowL)).toBeLessThanOrEqual(0.26);
      expect(Math.abs(peak.bowR)).toBeLessThanOrEqual(0.26);
      for (const j of [...peak.ridgeL, ...peak.ridgeR]) {
        expect(Math.abs(j)).toBeLessThanOrEqual(MAX_CRAG);
      }
    }
    const bows = new Set(w.peaks.map((p) => `${p.bowL},${p.bowR}`));
    expect(bows.size).toBe(w.peaks.length);
  });

  it('gives every summit a ridged silhouette rather than a triangle', () => {
    for (const peak of w.peaks) {
      const s = peakShape(peak);
      const vertices = (s.body.match(/[ML]/g) ?? []).length;
      // Base corners + apex + both crag ridges — the flat-cone look came from
      // this being 3.
      expect(vertices).toBe(3 + RIDGE_STEPS * 2);
    }
  });

  it('snows only when flagged, and shades the away-facing part of the cap', () => {
    for (const peak of w.peaks) {
      const s = peakShape(peak);
      expect(s.snow === null).toBe(!peak.snow);
      if (peak.snow) {
        expect(s.snow).not.toContain('NaN');
        expect(s.snowShade).not.toBeNull();
        expect(s.snowShade).not.toContain('NaN');
      } else {
        expect(s.snowShade).toBeNull();
      }
    }
  });

  it('keeps every mountain facet inside its own footprint', () => {
    const numbers = (d: string): number[] =>
      (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    for (const peak of w.peaks) {
      const s = peakShape(peak);
      const xs: number[] = [];
      const ys: number[] = [];
      for (const d of [s.body, s.lit, s.shade, s.snow ?? '']) {
        const n = numbers(d);
        for (let i = 0; i < n.length; i += 2) {
          xs.push(n[i]);
          ys.push(n[i + 1]);
        }
      }
      // Ridges and shoulders push outward, so allow a margin — but a facet must
      // not wander off across the map, and nothing may poke below the base line.
      expect(Math.min(...xs)).toBeGreaterThan(peak.x - peak.baseR * 1.6);
      expect(Math.max(...xs)).toBeLessThan(peak.x + peak.baseR * 1.6);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(peak.y - peak.height * 1.05);
      expect(Math.max(...ys)).toBeLessThanOrEqual(peak.y + 0.01);
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

  it('separates the rock facet tones enough to read as volume', () => {
    const luma = (hex: string): number => {
      const n = parseInt(hex.slice(1), 16);
      return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
    };
    for (const ramp of [GREY_ROCK, RED_ROCK]) {
      expect(luma(ramp.light)).toBeGreaterThan(luma(ramp.mid));
      expect(luma(ramp.mid)).toBeGreaterThan(luma(ramp.shade));
      // The flat-cone look came from these two sitting a few percent apart.
      expect(luma(ramp.light) - luma(ramp.mid)).toBeGreaterThan(40);
      // ...and the sunlit facet must stay clearly darker than snow, or the cap
      // disappears into the rock it sits on.
      expect(luma(LAND.snow) - luma(ramp.light)).toBeGreaterThan(40);
    }
  });
});

describe('shade', () => {
  const cases: [string, number, string][] = [
    ['#000000', 1, '#ffffff'],
    ['#ffffff', -1, '#000000'],
    ['#808080', 0, '#808080'],
    ['#000', 1, '#ffffff'],
  ];
  for (const [hex, amount, expected] of cases) {
    it(`shade(${hex}, ${amount}) → ${expected}`, () => {
      expect(shade(hex, amount)).toBe(expected);
    });
  }

  it('lightens and darkens monotonically, staying in gamut', () => {
    expect(shade('#7c848c', 0.2)).not.toBe('#7c848c');
    for (const amount of [-2, -0.5, 0.5, 2]) {
      const out = shade('#7c848c', amount);
      expect(isValidColor(out)).toBe(true);
    }
  });

  it('passes non-hex input straight through rather than emitting garbage', () => {
    expect(shade('rebeccapurple', 0.5)).toBe('rebeccapurple');
    expect(shade('', 0.5)).toBe('');
  });
});

describe('rockRamp', () => {
  it('is a no-op at tone 0 and always yields valid hex', () => {
    expect(rockRamp(GREY_ROCK, 0)).toEqual(GREY_ROCK);
    for (const tone of [-1, -0.4, 0.4, 1]) {
      for (const ramp of [GREY_ROCK, RED_ROCK]) {
        for (const value of Object.values(rockRamp(ramp, tone))) {
          expect(isValidColor(value)).toBe(true);
        }
      }
    }
  });

  it('moves every stop in the same direction', () => {
    const lighter = rockRamp(GREY_ROCK, 1);
    const darker = rockRamp(GREY_ROCK, -1);
    expect(lighter.mid).not.toBe(darker.mid);
    expect(parseInt(lighter.mid.slice(1), 16)).toBeGreaterThan(parseInt(darker.mid.slice(1), 16));
  });
});

describe('openGround', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: only accepts standable ground`, () => {
      const w = generateWorld(seed);
      const pad = 26;
      const ok = openGround(w, pad);
      // Sweep the canvas rather than trusting a handful of points.
      let accepted = 0;
      for (let x = 20; x < WORLD_W; x += 37) {
        for (let y = 20; y < WORLD_H; y += 41) {
          const p = { x, y };
          if (!ok(p)) continue;
          accepted++;
          expect(pointInPolygon(p, w.coast)).toBe(true);
          for (const lake of w.lakes) {
            expect(Math.hypot(p.x - lake.center.x, p.y - lake.center.y))
              .toBeGreaterThanOrEqual(lake.radius + pad);
          }
          for (const peak of w.peaks) {
            expect(Math.hypot(p.x - peak.x, p.y - peak.y)).toBeGreaterThanOrEqual(peak.baseR + pad);
          }
          for (const river of w.rivers) {
            for (const q of river.points) {
              expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(river.width * 0.8 + pad);
            }
          }
        }
      }
      // A predicate that rejects everything would pass all the above vacuously.
      expect(accepted).toBeGreaterThan(10);
    });
  }

  it('rejects open sea', () => {
    const w = generateWorld(42);
    const ok = openGround(w);
    expect(ok({ x: 5, y: 5 })).toBe(false);
    expect(ok({ x: WORLD_W - 5, y: WORLD_H - 5 })).toBe(false);
  });

  it('gets stricter as the pad grows', () => {
    const w = generateWorld(42);
    const count = (pad: number): number => {
      const ok = openGround(w, pad);
      let n = 0;
      for (let x = 20; x < WORLD_W; x += 23) {
        for (let y = 20; y < WORLD_H; y += 29) if (ok({ x, y })) n++;
      }
      return n;
    };
    expect(count(80)).toBeLessThan(count(10));
  });
});

describe('sceneryOrder', () => {
  const w = generateWorld(42);

  it('covers every tree and peak exactly once', () => {
    const order = sceneryOrder(w);
    expect(order).toHaveLength(w.trees.length + w.peaks.length);
    const trees = order.filter((i) => i.kind === 'tree').map((i) => i.index).sort((a, b) => a - b);
    const peaks = order.filter((i) => i.kind === 'peak').map((i) => i.index).sort((a, b) => a - b);
    expect(trees).toEqual(w.trees.map((_, i) => i));
    expect(peaks).toEqual(w.peaks.map((_, i) => i));
  });

  it('runs strictly back to front', () => {
    const ys = sceneryOrder(w).map((i) => i.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it('interleaves the two kinds rather than grouping them', () => {
    const kinds = sceneryOrder(w).map((i) => i.kind);
    let switches = 0;
    for (let i = 1; i < kinds.length; i++) {
      if (kinds[i] !== kinds[i - 1]) switches++;
    }
    expect(switches).toBeGreaterThan(2);
  });

  it('is stable for a given world', () => {
    expect(sceneryOrder(w)).toEqual(sceneryOrder(generateWorld(42)));
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
