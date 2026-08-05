// Procedural world generator for the Discovery screen.
//
// Everything here is pure and seeded: generateWorld(n) returns the same plain
// object every time, and the SVG components are a dumb projection of it. That
// split is what makes the interesting logic (keeping trees out of the sea,
// rivers reaching the coast) testable in the node-only vitest environment.

import { makeRng, type Rng } from './rng';
import {
  catmullRomPath,
  centroid,
  clampInside,
  dist,
  insetPolygon,
  jitterRing,
  lerp,
  nearestIndex,
  pointInPolygon,
  type Pt,
} from './geometry';
import { BIOME_KINDS, type BiomeKind } from './palette';

export const WORLD_W = 1600;
export const WORLD_H = 900;

/** Hard ceiling on tree nodes. Past this the SVG starts to cost more than it adds. */
export const MAX_TREES = 320;

export interface Biome {
  kind: BiomeKind;
  center: Pt;
  /** Outer edge, already clipped inside the coastline. */
  region: Pt[];
  /** Nested steps, outermost first — the stacked-plateau height cue. */
  terraces: Pt[][];
}

export interface River {
  points: Pt[];
  width: number;
}

export interface Lake {
  center: Pt;
  radius: number;
  ring: Pt[];
}

export interface Tree {
  x: number;
  y: number;
  size: number;
  /** 0–1; becomes a CSS animation-delay so the canopy doesn't sway in lockstep. */
  sway: number;
}

export interface Peak {
  x: number;
  y: number;
  baseR: number;
  height: number;
  /** Horizontal apex offset, so spires lean instead of standing to attention. */
  tilt: number;
  snow: boolean;
}

export type SettlementKind = 'hut' | 'camp' | 'ruin';

export interface Settlement {
  x: number;
  y: number;
  kind: SettlementKind;
  name: string;
}

export interface Cloud {
  x: number;
  y: number;
  rx: number;
  ry: number;
  opacity: number;
  /** Seconds for one drift across the map, and the head start into that loop. */
  duration: number;
  delay: number;
}

export interface World {
  seed: number;
  width: number;
  height: number;
  coast: Pt[];
  islets: Pt[][];
  biomes: Biome[];
  rivers: River[];
  lakes: Lake[];
  trees: Tree[];
  peaks: Peak[];
  trails: Pt[][];
  settlements: Settlement[];
  clouds: Cloud[];
}

/** A circle of water that scatter passes must avoid. */
interface WaterDisc {
  x: number;
  y: number;
  r: number;
}

const NAME_HEADS = [
  'Bram', 'Kel', 'Vor', 'Ash', 'Dun', 'Mor', 'Thal', 'Fen', 'Gral', 'Ryn',
  'Ost', 'Hel', 'Cairn', 'Vel', 'Torr',
];
const NAME_TAILS = [
  'hollow', 'reach', 'ford', 'crest', 'mere', 'gate', 'fell', 'watch',
  'barrow', 'moor', 'hold', 'spire',
];

function nearWater(p: Pt, water: readonly WaterDisc[], pad: number): boolean {
  for (const w of water) {
    if (dist(p, w) < w.r + pad) return true;
  }
  return false;
}

/**
 * Rejection sampling inside the coastline. Returns null after `attempts` misses
 * rather than relaxing the constraints — a slightly sparser forest is always
 * better than a tree standing in the ocean.
 */
function scatter(
  rng: Rng,
  coast: readonly Pt[],
  around: Pt,
  radius: number,
  reject: (p: Pt) => boolean,
  attempts = 12,
): Pt | null {
  for (let i = 0; i < attempts; i++) {
    const a = rng.range(0, Math.PI * 2);
    // sqrt keeps the distribution even across the disc instead of centre-heavy.
    const d = Math.sqrt(rng.next()) * radius;
    const p = { x: around.x + Math.cos(a) * d, y: around.y + Math.sin(a) * d };
    if (!pointInPolygon(p, coast)) continue;
    if (reject(p)) continue;
    return p;
  }
  return null;
}

function buildCoast(rng: Rng): Pt[] {
  // Wider than tall, filling the 16:9 frame with sea on all sides — the
  // reference image reads as one island with a visible horizon of water.
  return jitterRing(WORLD_W / 2, WORLD_H / 2, WORLD_W * 0.37, WORLD_H * 0.36, 46, rng, 0.26);
}

function buildIslets(rng: Rng, coast: readonly Pt[]): Pt[][] {
  const islets: Pt[][] = [];
  const count = rng.int(2, 4);
  for (let i = 0; i < count; i++) {
    // Ring the island at a radius that lands clearly offshore, then keep only
    // the ones that really are outside the coastline.
    const a = rng.range(0, Math.PI * 2);
    const x = WORLD_W / 2 + Math.cos(a) * WORLD_W * rng.range(0.42, 0.47);
    const y = WORLD_H / 2 + Math.sin(a) * WORLD_H * rng.range(0.42, 0.47);
    if (x < 60 || x > WORLD_W - 60 || y < 50 || y > WORLD_H - 50) continue;
    if (pointInPolygon({ x, y }, coast)) continue;
    const r = rng.range(16, 38);
    islets.push(jitterRing(x, y, r, r * rng.range(0.6, 0.9), 12, rng, 0.3));
  }
  return islets;
}

/**
 * Biome layout. Not a Voronoi partition — each biome is its own blob clipped to
 * the coastline, which overlaps neighbours slightly. That overlap is wanted: it
 * reads as terrain merging rather than as a political map.
 */
function buildBiomes(rng: Rng, coast: readonly Pt[]): Biome[] {
  const islandCenter = centroid(coast);
  const count = rng.int(5, 7);
  const biomes: Biome[] = [];

  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const spread = rng.range(0.25, 0.62);
    const raw = {
      x: islandCenter.x + Math.cos(a) * WORLD_W * 0.3 * spread,
      y: islandCenter.y + Math.sin(a) * WORLD_H * 0.32 * spread,
    };
    const center = clampInside(raw, coast, islandCenter);

    // The red-rock canyon belongs on the right edge, as in the reference; snow
    // sits high on the map. Everything else is grass or grey highland.
    let kind: BiomeKind;
    if (center.x > WORLD_W * 0.66) kind = 'redrock';
    else if (center.y < WORLD_H * 0.3 && rng.chance(0.6)) kind = 'snowfield';
    else kind = rng.chance(0.55) ? 'grass' : 'highland';

    const rx = rng.range(150, 260);
    const ry = rng.range(120, 210);
    const region = jitterRing(center.x, center.y, rx, ry, 22, rng, 0.24).map((p) =>
      clampInside(p, coast, center),
    );

    const steps = rng.int(2, 3);
    const terraces: Pt[][] = [];
    for (let s = 1; s <= steps; s++) {
      terraces.push(insetPolygon(region, s * rng.range(16, 26)));
    }
    biomes.push({ kind, center, region, terraces });
  }

  // Guarantee at least one of every kind is *possible* to look at without
  // depending on the dice: if nothing came out as redrock, retint the
  // right-most biome. Cheap, and keeps every seed visually varied.
  if (!biomes.some((b) => b.kind === 'redrock') && biomes.length > 0) {
    let rightmost = 0;
    for (let i = 1; i < biomes.length; i++) {
      if (biomes[i].center.x > biomes[rightmost].center.x) rightmost = i;
    }
    biomes[rightmost].kind = 'redrock';
  }
  return biomes;
}

/**
 * One trunk river plus tributaries. The trunk walks from an inland source to a
 * coast vertex and one step beyond it, so the mouth visually merges with the
 * sea instead of stopping short of the shoreline.
 */
function buildRivers(rng: Rng, coast: readonly Pt[], biomes: readonly Biome[]): River[] {
  const islandCenter = centroid(coast);
  const source =
    biomes.find((b) => b.kind === 'highland' || b.kind === 'snowfield')?.center ?? islandCenter;

  const mouthIndex = rng.int(0, coast.length - 1);
  const mouth = coast[mouthIndex];
  const beyond = {
    x: mouth.x + (mouth.x - islandCenter.x) * 0.06,
    y: mouth.y + (mouth.y - islandCenter.y) * 0.06,
  };

  const segments = rng.int(5, 7);
  const trunk: Pt[] = [{ x: source.x, y: source.y }];
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const perp = { x: -(mouth.y - source.y), y: mouth.x - source.x };
    const len = Math.hypot(perp.x, perp.y) || 1;
    // Meander amplitude peaks mid-course and dies at both ends, so the source
    // and the mouth stay put while the middle wanders.
    const amp = Math.sin(t * Math.PI) * rng.range(-90, 90);
    trunk.push({
      x: lerp(source.x, mouth.x, t) + (perp.x / len) * amp,
      y: lerp(source.y, mouth.y, t) + (perp.y / len) * amp,
    });
  }
  trunk.push(mouth, beyond);

  const rivers: River[] = [{ points: trunk, width: rng.range(16, 24) }];

  const tributaries = rng.int(2, 4);
  for (let i = 0; i < tributaries; i++) {
    const joinAt = rng.int(1, trunk.length - 3);
    const join = trunk[joinAt];
    const start = clampInside(
      {
        x: join.x + rng.range(-300, 300),
        y: join.y + rng.range(-240, 240),
      },
      coast,
      islandCenter,
    );
    const mid = {
      x: lerp(start.x, join.x, 0.5) + rng.range(-60, 60),
      y: lerp(start.y, join.y, 0.5) + rng.range(-60, 60),
    };
    rivers.push({ points: [start, mid, join], width: rng.range(7, 12) });
  }
  return rivers;
}

function buildLakes(rng: Rng, coast: readonly Pt[], rivers: readonly River[]): Lake[] {
  const islandCenter = centroid(coast);
  const lakes: Lake[] = [];

  // Junction pools: where a tributary meets the trunk is a natural basin.
  for (const river of rivers.slice(1)) {
    if (!rng.chance(0.7)) continue;
    const at = river.points[0];
    const radius = rng.range(18, 34);
    if (!pointInPolygon(at, coast)) continue;
    lakes.push({ center: at, radius, ring: jitterRing(at.x, at.y, radius, radius * 0.78, 14, rng, 0.22) });
  }

  // Standalone tarns.
  const extra = rng.int(3, 6);
  for (let i = 0; i < extra; i++) {
    const p = scatter(rng, coast, islandCenter, WORLD_W * 0.34, () => false);
    if (!p) continue;
    const radius = rng.range(12, 30);
    lakes.push({ center: p, radius, ring: jitterRing(p.x, p.y, radius, radius * 0.75, 14, rng, 0.24) });
  }
  return lakes;
}

function buildPeaks(
  rng: Rng,
  coast: readonly Pt[],
  biomes: readonly Biome[],
  water: readonly WaterDisc[],
): Peak[] {
  const peaks: Peak[] = [];
  for (const biome of biomes) {
    if (biome.kind === 'grass') continue;
    const count = biome.kind === 'redrock' ? rng.int(4, 7) : rng.int(3, 6);
    for (let i = 0; i < count; i++) {
      const p = scatter(rng, coast, biome.center, 170, (q) => nearWater(q, water, 24));
      if (!p) continue;
      const baseR = rng.range(20, 42);
      const height = baseR * rng.range(1.6, 3.1);
      peaks.push({
        x: p.x,
        y: p.y,
        baseR,
        height,
        tilt: rng.range(-baseR * 0.35, baseR * 0.35),
        // Snow only on the genuinely tall spires, and never on red rock — that
        // region reads as hot desert canyon.
        snow: biome.kind !== 'redrock' && height > baseR * 2.2,
      });
    }
  }
  return peaks.sort((a, b) => a.y - b.y);
}

function buildTrees(
  rng: Rng,
  coast: readonly Pt[],
  biomes: readonly Biome[],
  water: readonly WaterDisc[],
  peaks: readonly Peak[],
): Tree[] {
  const trees: Tree[] = [];
  const forested = biomes.filter((b) => b.kind === 'grass' || b.kind === 'highland');
  const clusters: { at: Pt; radius: number; count: number }[] = [];

  for (const biome of forested) {
    const groves = rng.int(2, 4);
    for (let g = 0; g < groves; g++) {
      const at = scatter(rng, coast, biome.center, 160, (q) => nearWater(q, water, 18));
      if (!at) continue;
      clusters.push({ at, radius: rng.range(45, 105), count: rng.int(10, 30) });
    }
  }

  const reject = (q: Pt): boolean => {
    if (nearWater(q, water, 14)) return true;
    for (const pk of peaks) {
      if (dist(q, pk) < pk.baseR * 0.9) return true;
    }
    return false;
  };

  for (const cluster of clusters) {
    for (let i = 0; i < cluster.count && trees.length < MAX_TREES; i++) {
      const p = scatter(rng, coast, cluster.at, cluster.radius, reject);
      if (!p) continue;
      trees.push({ x: p.x, y: p.y, size: rng.range(9, 17), sway: rng.next() });
    }
    if (trees.length >= MAX_TREES) break;
  }
  // Painter's order: further-back trees drawn first so canopies overlap downhill.
  return trees.sort((a, b) => a.y - b.y);
}

function buildSettlements(
  rng: Rng,
  coast: readonly Pt[],
  biomes: readonly Biome[],
  water: readonly WaterDisc[],
  peaks: readonly Peak[],
): Settlement[] {
  const settlements: Settlement[] = [];
  const target = rng.int(3, 6);
  const candidates = biomes.filter((b) => b.kind !== 'snowfield');
  const pool = candidates.length > 0 ? candidates : biomes;

  const reject = (q: Pt): boolean => {
    if (nearWater(q, water, 26)) return true;
    for (const pk of peaks) {
      if (dist(q, pk) < pk.baseR + 14) return true;
    }
    for (const s of settlements) {
      if (dist(q, s) < 120) return true;
    }
    return false;
  };

  for (let i = 0; i < target; i++) {
    const biome = pool[i % pool.length];
    const p = scatter(rng, coast, biome.center, 150, reject, 20);
    if (!p) continue;
    const kind: SettlementKind = biome.kind === 'redrock'
      ? rng.pick<SettlementKind>(['ruin', 'camp'])
      : rng.pick<SettlementKind>(['hut', 'hut', 'camp', 'ruin']);
    settlements.push({
      x: p.x,
      y: p.y,
      kind,
      name: rng.pick(NAME_HEADS) + rng.pick(NAME_TAILS),
    });
  }
  return settlements;
}

/**
 * Trails as a nearest-neighbour chain over the settlements, each leg bowed by a
 * seeded midpoint offset. Deliberately not a pathfinder — a trail that merely
 * looks like it followed the terrain is indistinguishable at this zoom, and
 * routing around every lake would cost far more than it shows.
 */
function buildTrails(rng: Rng, coast: readonly Pt[], settlements: readonly Settlement[]): Pt[][] {
  if (settlements.length < 2) return [];
  const remaining = settlements.map((s) => ({ x: s.x, y: s.y }));
  const order: Pt[] = [remaining.shift()!];
  while (remaining.length > 0) {
    const idx = nearestIndex(order[order.length - 1], remaining);
    order.push(remaining.splice(idx, 1)[0]);
  }

  const islandCenter = centroid(coast);
  const trails: Pt[][] = [];
  for (let i = 0; i < order.length - 1; i++) {
    const a = order[i];
    const b = order[i + 1];
    const bow = rng.range(-70, 70);
    const perp = { x: -(b.y - a.y), y: b.x - a.x };
    const len = Math.hypot(perp.x, perp.y) || 1;
    const mid = clampInside(
      {
        x: lerp(a.x, b.x, 0.5) + (perp.x / len) * bow,
        y: lerp(a.y, b.y, 0.5) + (perp.y / len) * bow,
      },
      coast,
      islandCenter,
    );
    const quarter = clampInside(
      { x: lerp(a.x, mid.x, 0.5) + rng.range(-24, 24), y: lerp(a.y, mid.y, 0.5) + rng.range(-24, 24) },
      coast,
      islandCenter,
    );
    trails.push([a, quarter, mid, b]);
  }
  return trails;
}

function buildClouds(rng: Rng): Cloud[] {
  const clouds: Cloud[] = [];
  const count = rng.int(4, 6);
  for (let i = 0; i < count; i++) {
    clouds.push({
      x: rng.range(-200, WORLD_W),
      y: rng.range(40, WORLD_H - 40),
      rx: rng.range(160, 340),
      ry: rng.range(50, 120),
      opacity: rng.range(0.05, 0.14),
      duration: rng.range(70, 160),
      delay: -rng.range(0, 160),
    });
  }
  return clouds;
}

/** Water obstacles derived from rivers and lakes, for the scatter passes. */
function waterDiscs(rivers: readonly River[], lakes: readonly Lake[]): WaterDisc[] {
  const discs: WaterDisc[] = [];
  for (const river of rivers) {
    for (const p of river.points) discs.push({ x: p.x, y: p.y, r: river.width * 0.8 });
  }
  for (const lake of lakes) discs.push({ x: lake.center.x, y: lake.center.y, r: lake.radius });
  return discs;
}

/**
 * Builds a whole world from a seed. Order matters: later passes consume the
 * earlier ones as obstacles, which is why rivers and lakes are generated before
 * anything that has to stand on dry land.
 */
export function generateWorld(seed: number): World {
  const rng = makeRng(seed);
  const coast = buildCoast(rng);
  const islets = buildIslets(rng, coast);
  const biomes = buildBiomes(rng, coast);
  const rivers = buildRivers(rng, coast, biomes);
  const lakes = buildLakes(rng, coast, rivers);
  const water = waterDiscs(rivers, lakes);
  const peaks = buildPeaks(rng, coast, biomes, water);
  const trees = buildTrees(rng, coast, biomes, water, peaks);
  const settlements = buildSettlements(rng, coast, biomes, water, peaks);
  const trails = buildTrails(rng, coast, settlements);
  const clouds = buildClouds(rng);

  return {
    seed,
    width: WORLD_W,
    height: WORLD_H,
    coast,
    islets,
    biomes,
    rivers,
    lakes,
    trees,
    peaks,
    trails,
    settlements,
    clouds,
  };
}

/** Closed smooth outline — used for the coastline and every biome/lake blob. */
export function ringPath(points: readonly Pt[]): string {
  return catmullRomPath(points, true);
}

/** Open smooth line — used for rivers and trails. */
export function linePath(points: readonly Pt[]): string {
  return catmullRomPath(points, false);
}

/** Kinds present in this world, in canonical palette order — for the legend. */
export function worldBiomeKinds(world: World): BiomeKind[] {
  const present = new Set(world.biomes.map((b) => b.kind));
  return BIOME_KINDS.filter((k) => present.has(k));
}
