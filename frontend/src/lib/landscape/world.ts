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
  /**
   * The widest point on the course. This is the clearance radius the scatter
   * passes reserve, so it must stay the maximum of `widths` — over-reserving near
   * the narrow headwaters only holds a few trees further back, whereas
   * under-reserving would let one stand in the water.
   */
  width: number;
  /**
   * Channel width at each point: narrow at the source, stepping up below every
   * confluence and flaring at the mouth. Per-point rather than one scalar because
   * two exactly parallel banks are the one thing no real river has.
   */
  widths: number[];
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

/** One talus block at a mountain's foot, offset from its base centre. */
export interface Scree {
  dx: number;
  dy: number;
  r: number;
}

/** A subordinate summit on one flank, so a massif isn't a single lonely cone. */
export interface Shoulder {
  /** -1 for the left ridge, 1 for the right. */
  side: -1 | 1;
  /** Fraction along that ridge, apex (0) to base (1), where the shoulder sits. */
  at: number;
  /** Its own height as a fraction of the main summit's. */
  h: number;
}

/** How many intermediate vertices each ridge carries. More reads as noise. */
export const RIDGE_STEPS = 4;

export interface Peak {
  x: number;
  y: number;
  baseR: number;
  height: number;
  /** Horizontal apex offset, so spires lean instead of standing to attention. */
  tilt: number;
  /**
   * True for the canyon region, which is drawn in red stone and never snows.
   *
   * Red rock was briefly rendered as flat-topped mesas to echo the reference's
   * layered canyon. It read as cardboard boxes — a plateau has no silhouette to
   * speak of at this scale, so the shape carried no information and the strata
   * looked like corrugation. Red peaks are the same spires as the highlands.
   */
  red: boolean;
  /**
   * Per-vertex lateral jitter for each ridge, in units of baseR. This is what
   * makes the silhouette a chiselled arête rather than the straight hypotenuse
   * of a triangle — every peak gets its own crags.
   */
  ridgeL: number[];
  ridgeR: number[];
  /**
   * Smooth curvature of each flank, in units of baseR: positive bulges the face
   * outward, negative hollows it inward. This is what actually carries silhouette
   * variety at map scale — small crags are invisible, whereas one convex and one
   * concave flank makes a summit look chiselled and asymmetric.
   */
  bowL: number;
  bowR: number;
  shoulders: Shoulder[];
  snow: boolean;
  /** Fraction of the height, measured down from the apex, that snow covers. */
  snowline: number;
  /** -1..1 tone offset, so a range has internal colour variation. */
  tone: number;
  scree: Scree[];
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
    // Weighted toward grass: the island should read as green with stone as the
    // accent. An even split left whole seeds looking like a quarry.
    else kind = rng.chance(0.68) ? 'grass' : 'highland';

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

  if (biomes.length === 0) return biomes;

  // Two guarantees, so no seed produces a dud composition. Without the redrock
  // one a world can lose its warm accent; without the highland one it can come
  // out all grass — and since only non-grass biomes grow mountains, that means
  // an island with no summits at all.
  if (!biomes.some((b) => b.kind === 'redrock')) {
    let rightmost = 0;
    for (let i = 1; i < biomes.length; i++) {
      if (biomes[i].center.x > biomes[rightmost].center.x) rightmost = i;
    }
    biomes[rightmost].kind = 'redrock';
  }
  if (!biomes.some((b) => b.kind === 'highland' || b.kind === 'snowfield')) {
    // Retint the most central grass biome, so the range lands inland rather
    // than hanging off an edge.
    const islandCenter = centroid(coast);
    const grass = biomes.filter((b) => b.kind === 'grass');
    if (grass.length > 0) {
      let best = grass[0];
      for (const b of grass) {
        if (dist(b.center, islandCenter) < dist(best.center, islandCenter)) best = b;
      }
      best.kind = 'highland';
    }
  }
  return biomes;
}

/**
 * Flow the trunk already carries at its source, in units of its own catchment.
 *
 * Nonzero so the headwater is a thin stream rather than a point of zero width,
 * which would draw as a needle and read as an artefact.
 */
const HEAD_FLOW = 0.12;

/** Width multipliers at the last two trunk points — the estuary opening out. */
const MOUTH_FLARE = 1.1;
const SEA_FLARE = 1.28;

/** A tributary may not exceed this fraction of the trunk width where it joins. */
const TRIB_CEILING = 0.8;

/** Width fractions along a tributary: source, middle, confluence. */
const TRIB_PROFILE = [0.35, 0.62, 1];

/**
 * The fraction of a river's width that the scatter passes keep clear of it.
 *
 * Exported because `waterDiscs` here, `openGround`'s test, and the river renderer's
 * "never draws wider than it reserved" invariant all need the same number, and
 * three copies of a literal is three chances for one of them to drift.
 */
export const WATER_RESERVE = 0.8;

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
  const perp = { x: -(mouth.y - source.y), y: mouth.x - source.x };
  const perpLen = Math.hypot(perp.x, perp.y) || 1;
  // One coherent meander for the whole course, not an independent draw per point.
  // A fresh random offset at every vertex lets consecutive points swing to opposite
  // extremes, which draws as a zigzag and — where the source happens to sit near the
  // chosen mouth — turns hard enough that a widened channel would fold through
  // itself. A single wave has the same amplitude budget and cannot do either.
  const swing = rng.range(45, 90);
  const waves = rng.range(1.2, 2.6);
  const phase = rng.range(0, Math.PI * 2);
  const trunk: Pt[] = [{ x: source.x, y: source.y }];
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    // The envelope dies at both ends, so the source and the mouth stay put while
    // the middle wanders.
    const amp = Math.sin(t * Math.PI) * swing * Math.sin(t * waves * Math.PI + phase);
    trunk.push({
      x: lerp(source.x, mouth.x, t) + (perp.x / perpLen) * amp,
      y: lerp(source.y, mouth.y, t) + (perp.y / perpLen) * amp,
    });
  }
  trunk.push(mouth, beyond);

  // Widest point of the whole system, at the estuary. Every other width is a
  // fraction of it, so this one number is also the clearance the scatter passes
  // reserve for the trunk.
  const trunkWidth = rng.range(22, 32);

  // Pass 1 — tributary courses, with the width each would like to be.
  const tribs: { points: Pt[]; joinAt: number; want: number }[] = [];
  const tributaries = rng.int(2, 4);
  for (let i = 0; i < tributaries; i++) {
    const joinAt = rng.int(1, trunk.length - 3);
    const join = trunk[joinAt];
    // Both signs of the offset, keeping whichever survives the clip better. A
    // junction near the shore has one side of it in the sea, and `clampInside` walks
    // a source there almost all the way back to the junction — leaving a tributary a
    // few dozen px long, which is not a river, it is a smudge. The mirrored offset
    // points inland from the same junction, so one of the two always has room.
    const dx = rng.range(-300, 300);
    const dy = rng.range(-240, 240);
    const candidates = [
      clampInside({ x: join.x + dx, y: join.y + dy }, coast, islandCenter),
      clampInside({ x: join.x - dx, y: join.y - dy }, coast, islandCenter),
    ];
    const start = candidates[0];
    if (dist(candidates[1], join) > dist(candidates[0], join)) {
      start.x = candidates[1].x;
      start.y = candidates[1].y;
    }
    // The middle point bows off the straight line by a share of the *span*, not by
    // a fixed number of pixels. `clampInside` can pull a source back to within a few
    // dozen px of the junction, and a flat ±60px jitter on a run that short doubles
    // the course back on itself — a hairpin whose bend radius is smaller than the
    // channel is wide, which no amount of care at draw time can render.
    const away = { x: join.x - start.x, y: join.y - start.y };
    const span = Math.hypot(away.x, away.y) || 1;
    const bow = rng.range(-0.22, 0.22) * span;
    const mid = {
      x: lerp(start.x, join.x, 0.5) - (away.y / span) * bow,
      y: lerp(start.y, join.y, 0.5) + (away.x / span) * bow,
    };
    tribs.push({ points: [start, mid, join], joinAt, want: rng.range(7, 12) });
  }

  // Pass 2 — trunk widths. Hydraulic geometry: width goes as the square root of
  // discharge, so the trunk's own catchment growing downstream and each tributary's
  // share arriving at its confluence both land on the same scale. The step at a
  // junction is the only place the eye can see that two rivers became one.
  const lastInland = Math.max(1, trunk.length - 3);
  const profile = trunk.map((_, i) => {
    let flow = HEAD_FLOW + Math.min(1, i / lastInland);
    for (const trib of tribs) {
      if (trib.joinAt <= i) flow += (trib.want / trunkWidth) ** 2;
    }
    return Math.sqrt(flow);
  });
  profile[profile.length - 2] *= MOUTH_FLARE;
  profile[profile.length - 1] *= SEA_FLARE;

  // Normalised to a peak of exactly `trunkWidth`, and the peak assigned literally
  // rather than computed. `width` is the radius `waterDiscs` reserves, so every
  // drawn half-width has to stay strictly under it — if the estuary flare could
  // push the maximum above `trunkWidth` instead, the reserve would grow with it and
  // the tree line would retreat along the entire course.
  let peakAt = 0;
  for (let i = 1; i < profile.length; i++) if (profile[i] > profile[peakAt]) peakAt = i;
  const trunkWidths = profile.map((p) => (trunkWidth * p) / profile[peakAt]);
  trunkWidths[peakAt] = trunkWidth;

  const rivers: River[] = [{ points: trunk, width: trunkWidth, widths: trunkWidths }];

  // Pass 3 — tributaries, capped against the trunk where they join. Uncapped, a
  // lucky draw gives a tributary that reads as the main stem and the confluence
  // looks like two rivers crossing.
  for (const trib of tribs) {
    const width = Math.min(trib.want, TRIB_CEILING * trunkWidths[trib.joinAt]);
    rivers.push({
      points: trib.points,
      width,
      // Tapers up to full width at the confluence, so it arrives at the trunk
      // rather than butting into it at full size.
      widths: TRIB_PROFILE.map((f) => f * width),
    });
  }
  return rivers;
}

function buildLakes(rng: Rng, coast: readonly Pt[], rivers: readonly River[]): Lake[] {
  const islandCenter = centroid(coast);
  const lakes: Lake[] = [];

  // Headwater tarns: the pool a tributary drains out of. Deliberately at
  // `points[0]`, the tributary's source, not its confluence — a pool sitting on the
  // junction would have to be smaller than the trunk's local half-width to avoid
  // swallowing it, whereas a tarn feeding a thin stream needs no such bound.
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

/**
 * Lateral crag offsets for one ridge, in units of baseR.
 *
 * Kept small on purpose. A ridge descends about 0.2·baseR in x per step, so an
 * offset anywhere near that lets adjacent vertices swap order — the silhouette
 * stops being a function of height and the mountain renders as shattered glass.
 * `MAX_CRAG` is the safe bound; character comes from the flank bow and the
 * shoulders instead, both of which cannot break the ordering.
 */
export const MAX_CRAG = 0.07;

function buildRidge(rng: Rng): number[] {
  return Array.from({ length: RIDGE_STEPS }, () => rng.range(-MAX_CRAG, MAX_CRAG));
}

function buildScree(rng: Rng, baseR: number): Scree[] {
  return Array.from({ length: rng.int(2, 5) }, () => ({
    dx: rng.range(-baseR * 1.1, baseR * 1.1),
    dy: rng.range(-1, baseR * 0.3),
    r: rng.range(1.6, 4),
  }));
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
    const red = biome.kind === 'redrock';
    const count = red ? rng.int(4, 7) : rng.int(3, 6);
    for (let i = 0; i < count; i++) {
      const p = scatter(rng, coast, biome.center, 170, (q) => nearWater(q, water, 24));
      if (!p) continue;

      // A range needs foothills as well as summits, or every silhouette repeats
      // at the same scale. Roughly a quarter come out low and broad.
      const low = rng.chance(0.28);
      const baseR = rng.range(22, 44);
      // Taller than the base is wide (ratio > 2, since the base spans 2·baseR).
      // At ratio 2 a summit is exactly as wide as it is tall and reads as a
      // shark fin sitting on the grass. Foothills stay deliberately squat.
      const height = baseR * (low ? rng.range(1.5, 2.0) : rng.range(2.2, 3.2));

      peaks.push({
        x: p.x,
        y: p.y,
        baseR,
        height,
        tilt: rng.range(-baseR * 0.3, baseR * 0.3),
        red,
        ridgeL: buildRidge(rng),
        ridgeR: buildRidge(rng),
        // Biased concave: a hollowed flank reads as an arête, whereas a bulging
        // one reads as a sail. Some outward bow is still wanted for variety.
        bowL: rng.range(-0.18, 0.1),
        bowR: rng.range(-0.18, 0.1),
        // One flanking summit is usually enough; two occasionally, for a proper
        // massif rather than a lonely cone.
        shoulders: Array.from({ length: rng.chance(0.55) ? (rng.chance(0.3) ? 2 : 1) : 0 }, () => ({
          side: (rng.chance(0.5) ? -1 : 1) as -1 | 1,
          at: rng.range(0.42, 0.72),
          h: rng.range(0.4, 0.68),
        })),
        // Snow only on the genuinely tall summits, and never on red rock — that
        // region reads as hot desert canyon.
        snow: !red && height > baseR * 2,
        // Varying where the snow stops matters more than how much there is: a
        // constant fraction made every cap look stamped from the same die.
        // Kept shallow — much past a third of the height and the summit turns
        // into a white hood with a grey skirt.
        snowline: rng.range(0.16, 0.32),
        tone: rng.range(-1, 1),
        scree: buildScree(rng, baseR),
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
    for (const p of river.points) discs.push({ x: p.x, y: p.y, r: river.width * WATER_RESERVE });
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

/**
 * A predicate for "somewhere you could actually stand": on the island, clear of
 * rivers and lakes, and not inside a mountain's footprint.
 *
 * Exposed because anything placing extra things on the map needs it — the
 * dinosaur utility, for one, knows nothing about islands and just takes an
 * `allow` callback.
 */
export function openGround(world: World, pad = 26): (p: Pt) => boolean {
  const discs = waterDiscs(world.rivers, world.lakes);
  return (p: Pt): boolean => {
    if (!pointInPolygon(p, world.coast)) return false;
    if (nearWater(p, discs, pad)) return false;
    for (const peak of world.peaks) {
      if (dist(p, peak) < peak.baseR + pad) return false;
    }
    return true;
  };
}

export interface SceneryItem {
  kind: 'tree' | 'peak';
  /** Index into world.trees or world.peaks. */
  index: number;
  y: number;
}

/**
 * Trees and peaks interleaved back-to-front.
 *
 * Drawing all peaks after all trees put every mountain in front of the whole
 * forest, including the trees standing downhill of it. One merged order makes a
 * mountain sit *in* its treeline. Ties put the peak first, so a tree at the same
 * depth reads as being at its foot.
 */
export function sceneryOrder(world: World): SceneryItem[] {
  const items: SceneryItem[] = [
    ...world.peaks.map((p, index) => ({ kind: 'peak' as const, index, y: p.y })),
    ...world.trees.map((t, index) => ({ kind: 'tree' as const, index, y: t.y })),
  ];
  return items.sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    if (a.kind === b.kind) return a.index - b.index;
    return a.kind === 'peak' ? -1 : 1;
  });
}

/** Kinds present in this world, in canonical palette order — for the legend. */
export function worldBiomeKinds(world: World): BiomeKind[] {
  const present = new Set(world.biomes.map((b) => b.kind));
  return BIOME_KINDS.filter((k) => present.has(k));
}
