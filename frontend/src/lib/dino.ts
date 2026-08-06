// Random dinosaur generator.
//
// A standalone utility: give it a name, get back a dinosaur — species, colours,
// markings and a position inside whatever bounds you hand it. The name is the
// seed, so `randomDino('Rexy')` is the same creature every time, while a
// different name is a different animal somewhere else.
//
// Pure and data-only, like lib/landscape/world.ts: nothing here touches the DOM
// or Math.random, so it is fully testable in the node-only vitest environment
// and any renderer (the Discovery map, a loading screen, an empty state) can
// project the result however it likes.
//
// Style follows flat dinosaur clip-art: one soft silhouette for body, neck, head
// and tail together, a lighter belly patch, dorsal plates, a dot eye and a
// smile. Drawing the parts separately is what makes this kind of figure look
// assembled rather than drawn, so the outline is deliberately a single ring.

import { makeRng, hashText, type Rng } from './landscape/rng';
import { catmullRomPath, polygonPath, type Pt } from './landscape/geometry';
import { shade } from './landscape/palette';
import type { Insets, Rect } from './viewbox';

export type DinoSpecies = 'sauropod' | 'theropod' | 'stegosaur' | 'triceratops';

export const DINO_SPECIES: readonly DinoSpecies[] = [
  'sauropod',
  'theropod',
  'stegosaur',
  'triceratops',
];

export type { Rect, Insets };

/**
 * How far a dinosaur reaches from its feet, in units of `size`.
 *
 * The feet are the anchor, so the figure extends about a size to each side, well
 * over a size upward, and barely at all below. A caller that must keep the whole
 * animal on screen insets its bounds by this — see `dinoInsets`.
 */
export const DINO_EXTENT = { left: 1.05, right: 1.05, top: 1.25, bottom: 0.18 } as const;

/** Bounds insets that keep an animal of up to `maxSize` fully inside a rect. */
export function dinoInsets(maxSize: number): Required<Insets> {
  return {
    left: DINO_EXTENT.left * maxSize,
    right: DINO_EXTENT.right * maxSize,
    top: DINO_EXTENT.top * maxSize,
    bottom: DINO_EXTENT.bottom * maxSize,
  };
}

/**
 * Default placement area. Matches the Discovery map's canvas because that is the
 * first caller; anything else should pass its own bounds.
 */
export const DEFAULT_BOUNDS: Rect = { x: 0, y: 0, width: 1600, height: 900 };

export interface DinoColors {
  body: string;
  belly: string;
  /** Plates, spikes or frill — the contrasting accent. */
  plate: string;
  spot: string;
  /** Toes and horns: a pale cream in the reference art. */
  claw: string;
}

/** A flank marking, in the same normalised space as the outline. */
export interface DinoSpot {
  u: number;
  v: number;
  r: number;
}

export interface Dino {
  name: string;
  species: DinoSpecies;
  /** Ground contact point: the feet, in the caller's coordinate space. */
  x: number;
  y: number;
  /** Scale in px — one normalised unit. Roughly the shoulder height. */
  size: number;
  /** 1 faces right, -1 faces left. */
  facing: 1 | -1;
  /** Which palette this animal drew. Exposed so a herd can be de-duplicated. */
  paletteIndex: number;
  colors: DinoColors;
  spots: DinoSpot[];
  /** 0–1, for staggering idle animation so a herd doesn't move in lockstep. */
  phase: number;
}

export interface DinoOptions {
  /** Where the feet may land. Defaults to DEFAULT_BOUNDS. */
  bounds?: Rect;
  /** Extra constraint on the position, e.g. "must be on land". */
  allow?: (p: Pt) => boolean;
  /** Placement attempts before giving up and returning null. */
  attempts?: number;
  /** Scale range in px. */
  minSize?: number;
  maxSize?: number;
  /** Force a species instead of picking one from the name. */
  species?: DinoSpecies;
  /**
   * Mixed into the seed. Same name + different variant = same-looking animal in
   * a different place, which is how a caller reshuffles a scene without
   * renaming everything.
   */
  variant?: number;
}

/** Bright flat-art palettes, in the spirit of the reference clip art. */
const PALETTES: readonly Omit<DinoColors, 'spot'>[] = [
  { body: '#e94f9b', belly: '#ffd9ec', plate: '#5ec269', claw: '#fff1c9' },
  { body: '#2f8fe0', belly: '#d7ecff', plate: '#f2a03d', claw: '#fff1c9' },
  { body: '#f2a03d', belly: '#ffe6bd', plate: '#8d5a3b', claw: '#fff6de' },
  { body: '#8a63d2', belly: '#e8dcff', plate: '#f5d13f', claw: '#fff1c9' },
  { body: '#5aab53', belly: '#e2f4c9', plate: '#f5d13f', claw: '#fff6de' },
  { body: '#33b3a6', belly: '#d5f4f0', plate: '#8a63d2', claw: '#fff1c9' },
  { body: '#e2603f', belly: '#ffdccd', plate: '#5aab53', claw: '#fff6de' },
];

/**
 * A species' anatomy in normalised units: u runs from tail (negative) to snout
 * (positive), v runs up from the ground, so v = 0 is where the feet meet the
 * terrain and the figure scales by one multiplier.
 */
interface DinoProfile {
  /** Single closed silhouette: body, neck, head and tail in one ring. */
  outline: readonly [number, number][];
  /** Lighter belly patch, drawn over the body. */
  belly: readonly [number, number][];
  eye: [number, number];
  eyeR: number;
  /** Short curve for the mouth. */
  smile: readonly [number, number][];
  /** Limbs: top-centre position, plus width and height. */
  legs: readonly { u: number; v: number; w: number; h: number }[];
  /** Spine the dorsal plates follow, tail-to-head. Empty for none. */
  plateSpine: readonly [number, number][];
  /** Plate style: rounded scallops, sharp triangles, or none. */
  plateStyle: 'scallop' | 'spike' | 'none';
  /** Multiplier on plate height — a stegosaur's are its defining feature. */
  plateScale: number;
  /**
   * Neck frill, for the triceratops — generated as a fan rather than authored as
   * points. Hand-placed points inevitably trace a smooth arc, and a polygon
   * through a smooth arc is a rounded blob: the first attempt read as a hair bun
   * behind the skull. Alternating the radius per scallop is what makes it a
   * collar.
   */
  frill?: {
    u: number;
    v: number;
    r: number;
    /** Sweep in degrees, measured from the +u axis (forward) counter-clockwise. */
    from: number;
    to: number;
    scallops: number;
  };
  /** Nose and brow horns. */
  horns?: readonly (readonly [number, number][])[];
  /** Tiny forelimbs, drawn over the body. */
  arms?: readonly (readonly [number, number][])[];
  /** Box the flank spots are scattered in. */
  spotArea: { u0: number; u1: number; v0: number; v1: number };
}

// Long neck, small head, four columnar legs, heavy tapering tail.
const SAUROPOD: DinoProfile = {
  outline: [
    [-0.98, 0.22], [-0.72, 0.3], [-0.44, 0.44], [-0.16, 0.54], [0.1, 0.58],
    [0.26, 0.68], [0.32, 0.86], [0.38, 1.02], [0.52, 1.12], [0.66, 1.08],
    [0.68, 0.96], [0.56, 0.9], [0.46, 0.78], [0.42, 0.6], [0.34, 0.4],
    [0.16, 0.28], [-0.1, 0.24], [-0.36, 0.22], [-0.66, 0.18],
  ],
  belly: [[-0.3, 0.26], [-0.05, 0.29], [0.2, 0.31], [0.24, 0.2], [-0.05, 0.16], [-0.32, 0.18]],
  eye: [0.56, 1.04],
  eyeR: 0.045,
  smile: [[0.6, 0.96], [0.65, 0.945], [0.68, 0.955]],
  legs: [
    { u: -0.26, v: 0.3, w: 0.15, h: 0.32 },
    { u: -0.05, v: 0.29, w: 0.14, h: 0.31 },
    { u: 0.14, v: 0.31, w: 0.14, h: 0.33 },
    { u: 0.3, v: 0.33, w: 0.13, h: 0.35 },
  ],
  plateSpine: [[-0.4, 0.46], [-0.16, 0.56], [0.08, 0.6], [0.26, 0.7], [0.32, 0.88]],
  plateStyle: 'scallop',
  plateScale: 0.85,
  spotArea: { u0: -0.4, u1: 0.15, v0: 0.34, v1: 0.52 },
};

// Upright biped: deep chest, big jaw, thick tail counterbalancing.
const THEROPOD: DinoProfile = {
  outline: [
    [-1.0, 0.3], [-0.7, 0.38], [-0.42, 0.52], [-0.18, 0.7], [-0.02, 0.9],
    [0.08, 1.06], [0.22, 1.16], [0.42, 1.14], [0.54, 1.04], [0.56, 0.9],
    [0.4, 0.86], [0.24, 0.82], [0.18, 0.66], [0.16, 0.46], [0.06, 0.3],
    [-0.14, 0.24], [-0.4, 0.24], [-0.7, 0.24],
  ],
  belly: [[-0.02, 0.34], [0.1, 0.5], [0.14, 0.68], [0.02, 0.7], [-0.08, 0.5], [-0.12, 0.34]],
  eye: [0.34, 1.06],
  eyeR: 0.05,
  smile: [[0.3, 0.9], [0.42, 0.875], [0.53, 0.9]],
  legs: [
    { u: -0.12, v: 0.32, w: 0.17, h: 0.34 },
    { u: 0.08, v: 0.32, w: 0.15, h: 0.34 },
  ],
  plateSpine: [[-0.5, 0.5], [-0.26, 0.64], [-0.06, 0.84], [0.06, 1.0]],
  plateStyle: 'spike',
  plateScale: 0.9,
  // Stubby forelimbs held up in front of the chest, as in every cartoon T-rex.
  arms: [[[0.16, 0.66], [0.3, 0.62], [0.34, 0.54], [0.26, 0.54], [0.16, 0.58]]],
  spotArea: { u0: -0.5, u1: -0.05, v0: 0.36, v1: 0.6 },
};

// Low slung, tiny head, tall plates along the whole back.
const STEGOSAUR: DinoProfile = {
  outline: [
    [-0.98, 0.3], [-0.7, 0.34], [-0.44, 0.44], [-0.14, 0.5], [0.14, 0.48],
    [0.34, 0.44], [0.5, 0.42], [0.62, 0.38], [0.64, 0.28], [0.5, 0.24],
    [0.32, 0.22], [0.1, 0.2], [-0.16, 0.2], [-0.44, 0.2], [-0.7, 0.22],
  ],
  belly: [[-0.34, 0.23], [-0.05, 0.24], [0.24, 0.24], [0.26, 0.15], [-0.05, 0.13], [-0.36, 0.15]],
  eye: [0.52, 0.36],
  eyeR: 0.04,
  smile: [[0.54, 0.29], [0.6, 0.278], [0.63, 0.288]],
  legs: [
    { u: -0.3, v: 0.24, w: 0.15, h: 0.26 },
    { u: -0.08, v: 0.23, w: 0.14, h: 0.25 },
    { u: 0.14, v: 0.23, w: 0.14, h: 0.25 },
    { u: 0.34, v: 0.24, w: 0.13, h: 0.26 },
  ],
  plateSpine: [[-0.6, 0.36], [-0.4, 0.44], [-0.18, 0.5], [0.06, 0.5], [0.28, 0.46]],
  plateStyle: 'spike',
  // Its whole silhouette is the plates — at parity with the others they read as
  // a hedgehog's bristles rather than a stegosaurus.
  plateScale: 2.1,
  spotArea: { u0: -0.5, u1: 0.1, v0: 0.28, v1: 0.42 },
};

// Bulky, short tail, and a big head that has to rise clear of the shoulders —
// otherwise the frill sits on the back and reads as a bun rather than a collar.
const TRICERATOPS: DinoProfile = {
  outline: [
    [-0.88, 0.3], [-0.64, 0.36], [-0.38, 0.48], [-0.08, 0.53], [0.18, 0.55],
    [0.32, 0.58], [0.46, 0.64], [0.6, 0.62], [0.72, 0.53], [0.79, 0.44],
    [0.74, 0.35], [0.6, 0.31], [0.44, 0.28], [0.28, 0.22], [0.02, 0.19],
    [-0.24, 0.19], [-0.52, 0.21], [-0.72, 0.24],
  ],
  belly: [[-0.38, 0.23], [-0.08, 0.24], [0.2, 0.23], [0.22, 0.14], [-0.08, 0.12], [-0.4, 0.15]],
  eye: [0.62, 0.5],
  eyeR: 0.042,
  smile: [[0.7, 0.4], [0.76, 0.388], [0.79, 0.4]],
  legs: [
    { u: -0.3, v: 0.23, w: 0.16, h: 0.25 },
    { u: -0.08, v: 0.22, w: 0.15, h: 0.24 },
    { u: 0.14, v: 0.22, w: 0.15, h: 0.24 },
    { u: 0.32, v: 0.23, w: 0.14, h: 0.25 },
  ],
  plateSpine: [],
  plateStyle: 'none',
  plateScale: 1,
  // Sweeping up and back from behind the skull, wider than the head so the
  // scalloped edge clears the silhouette on both sides.
  frill: { u: 0.44, v: 0.42, r: 0.36, from: 15, to: 205, scallops: 5 },
  horns: [
    // Nose horn, angled forward off the snout.
    [[0.74, 0.46], [0.96, 0.61], [0.8, 0.39]],
    // Brow horn, shorter and more upright.
    [[0.57, 0.6], [0.71, 0.87], [0.67, 0.57]],
  ],
  spotArea: { u0: -0.45, u1: 0.05, v0: 0.28, v1: 0.44 },
};

const PROFILES: Record<DinoSpecies, DinoProfile> = {
  sauropod: SAUROPOD,
  theropod: THEROPOD,
  stegosaur: STEGOSAUR,
  triceratops: TRICERATOPS,
};

/** How many distinct looks exist. A herd larger than this must repeat. */
export const DINO_PALETTE_COUNT = PALETTES.length;

function colorsAt(index: number): DinoColors {
  const base = PALETTES[((index % PALETTES.length) + PALETTES.length) % PALETTES.length];
  return {
    ...base,
    // Derived rather than listed, so a spot can never clash with its own body.
    spot: shade(base.body, -0.22),
  };
}

function buildSpots(rng: Rng, profile: DinoProfile): DinoSpot[] {
  const { u0, u1, v0, v1 } = profile.spotArea;
  return Array.from({ length: rng.int(3, 6) }, () => ({
    u: rng.range(u0, u1),
    v: rng.range(v0, v1),
    r: rng.range(0.035, 0.075),
  }));
}

/**
 * One dinosaur, seeded by its name.
 *
 * Returns null when `allow` rejects every attempted position — a caller placing
 * animals on an island would rather skip one than have it stand in the sea.
 */
export function randomDino(name: string, opts: DinoOptions = {}): Dino | null {
  const {
    bounds = DEFAULT_BOUNDS,
    allow,
    attempts = 24,
    minSize = 70,
    maxSize = 120,
    species,
    variant = 0,
  } = opts;

  const rng = makeRng((hashText(name) ^ Math.imul(variant, 0x9e3779b1)) >>> 0);
  const kind = species ?? rng.pick(DINO_SPECIES);
  const profile = PROFILES[kind];
  const size = rng.range(minSize, maxSize);
  const facing: 1 | -1 = rng.chance(0.5) ? 1 : -1;
  const paletteIndex = rng.int(0, PALETTES.length - 1);
  const spots = buildSpots(rng, profile);
  const phase = rng.next();

  for (let i = 0; i < attempts; i++) {
    const p = {
      x: rng.range(bounds.x, bounds.x + bounds.width),
      y: rng.range(bounds.y, bounds.y + bounds.height),
    };
    if (allow && !allow(p)) continue;
    return {
      name, species: kind, x: p.x, y: p.y, size, facing,
      paletteIndex, colors: colorsAt(paletteIndex), spots, phase,
    };
  }
  return null;
}

/**
 * A herd. Each animal is still seeded by its own name, but placement also keeps
 * them apart — two dinosaurs standing on the same spot read as one broken shape.
 */
export function randomDinos(
  names: readonly string[],
  opts: DinoOptions & { minGap?: number; distinctColors?: boolean } = {},
): Dino[] {
  const { minGap = 150, distinctColors = true, ...rest } = opts;
  const placed: Dino[] = [];
  const taken = new Set<number>();

  for (const name of names) {
    const dino = randomDino(name, {
      ...rest,
      allow: (p) => {
        if (rest.allow && !rest.allow(p)) return false;
        return placed.every((d) => Math.hypot(d.x - p.x, d.y - p.y) >= minGap);
      },
    });
    if (!dino) continue;

    // Each animal picks its own palette from its name, so a herd can easily end
    // up with two of the same colour — which defeats the point of naming them.
    // Walk forward to the next free palette instead; deterministic, and it only
    // repeats once the herd is larger than the palette set.
    if (distinctColors && taken.size < DINO_PALETTE_COUNT) {
      let index = dino.paletteIndex;
      while (taken.has(index)) index = (index + 1) % DINO_PALETTE_COUNT;
      dino.paletteIndex = index;
      dino.colors = colorsAt(index);
      taken.add(index);
    }
    placed.push(dino);
  }
  // Back-to-front, so a renderer can draw them in order and get correct overlap.
  return placed.sort((a, b) => a.y - b.y);
}

export interface DinoShape {
  /** Ground shadow, so the animal is standing rather than floating. */
  shadow: { cx: number; cy: number; rx: number; ry: number };
  /** Far-side legs, drawn behind the body in a darker tone. */
  legsBack: string[];
  /** Near-side legs, drawn over it. */
  legsFront: string[];
  /** Pale toe caps, one per near-side leg. */
  toes: { cx: number; cy: number; r: number }[];
  /** The single silhouette: body, neck, head and tail. */
  body: string;
  belly: string;
  plates: string[];
  frill: string | null;
  horns: string[];
  arms: string[];
  spots: { cx: number; cy: number; r: number }[];
  eye: { cx: number; cy: number; r: number };
  /** Catch-light, offset toward the light like every other highlight here. */
  glint: { cx: number; cy: number; r: number };
  smile: string;
}

/**
 * The frill as a fan with a scalloped rim: two vertices per scallop, one at full
 * radius and one pulled in, so the edge has real notches. Closed back through the
 * centre, which the body then covers — only the rim shows.
 */
function frillFan(frill: NonNullable<DinoProfile['frill']>): [number, number][] {
  const { u, v, r, from, to, scallops } = frill;
  const pts: [number, number][] = [];
  const steps = scallops * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = ((from + (to - from) * t) * Math.PI) / 180;
    const radius = i % 2 === 0 ? r : r * 0.78;
    pts.push([u + Math.cos(angle) * radius, v + Math.sin(angle) * radius]);
  }
  pts.push([u, v]);
  return pts;
}

/** An 8-point rounded limb, smoothed into a stumpy leg. */
function limbRing(u: number, vTop: number, w: number, h: number): [number, number][] {
  const hw = w / 2;
  const vBottom = vTop - h;
  const r = Math.min(hw, h * 0.35);
  return [
    [u - hw, vTop],
    [u + hw, vTop],
    [u + hw, vBottom + r],
    [u + hw - r * 0.6, vBottom],
    [u - hw + r * 0.6, vBottom],
    [u - hw, vBottom + r],
  ];
}

/** Plates along a spine: rounded scallops or sharp spikes, alternating size. */
function platePolys(profile: DinoProfile, rng: Rng): [number, number][][] {
  if (profile.plateStyle === 'none' || profile.plateSpine.length < 2) return [];
  const spine = profile.plateSpine;
  const polys: [number, number][][] = [];

  for (let i = 0; i < spine.length - 1; i++) {
    const [u0, v0] = spine[i];
    const [u1, v1] = spine[i + 1];
    const steps = 2;
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      const u = u0 + (u1 - u0) * t;
      const v = v0 + (v1 - v0) * t;
      // Along-spine direction, so plates lean with the back rather than all
      // standing vertically.
      const du = u1 - u0;
      const dv = v1 - v0;
      const len = Math.hypot(du, dv) || 1;
      const nu = -dv / len;
      const nv = du / len;
      const height = rng.range(0.09, 0.15) * profile.plateScale;
      const halfBase = 0.05;
      const baseU = u - (du / len) * halfBase;
      const baseV = v - (dv / len) * halfBase;
      const tipU = u + nu * height;
      const tipV = v + nv * height;
      const endU = u + (du / len) * halfBase;
      const endV = v + (dv / len) * halfBase;

      if (profile.plateStyle === 'spike') {
        polys.push([[baseU, baseV], [tipU, tipV], [endU, endV]]);
      } else {
        // A scallop is a spike with its point rounded off into two shoulders.
        polys.push([
          [baseU, baseV],
          [baseU + nu * height * 0.7, baseV + nv * height * 0.7],
          [tipU, tipV],
          [endU + nu * height * 0.7, endV + nv * height * 0.7],
          [endU, endV],
        ]);
      }
    }
  }
  return polys;
}

/**
 * Absolute SVG geometry for a dinosaur.
 *
 * Every profile is authored facing right; `facing` mirrors u, which is why the
 * mapping lives in one place rather than being baked into the tables.
 */
export function dinoShape(dino: Dino): DinoShape {
  const { x, y, size, facing } = dino;
  const P = (u: number, v: number): Pt => ({ x: x + facing * u * size, y: y - v * size });
  const map = (pts: readonly [number, number][]): Pt[] => pts.map(([u, v]) => P(u, v));

  const profile = PROFILES[dino.species];
  // Plate heights are randomised, so they need their own generator — seeded from
  // the same name, keeping dinoShape a pure function of the dino.
  const plateRng = makeRng(hashText(dino.name + ':plates'));
  const plates = platePolys(profile, plateRng);

  // Far legs sit slightly behind and are drawn first; near legs get the toes.
  const legRings = profile.legs.map((leg) => limbRing(leg.u, leg.v, leg.w, leg.h));
  const backCount = Math.floor(legRings.length / 2);
  const legsBack = legRings.slice(0, backCount);
  const legsFront = legRings.slice(backCount);

  const eye = P(profile.eye[0], profile.eye[1]);
  const eyeR = profile.eyeR * size;

  return {
    shadow: {
      cx: x + facing * size * 0.06,
      cy: y + size * 0.03,
      rx: size * 0.62,
      ry: size * 0.1,
    },
    legsBack: legsBack.map((ring) => catmullRomPath(map(ring), true)),
    legsFront: legsFront.map((ring) => catmullRomPath(map(ring), true)),
    toes: legsFront.map((ring) => {
      const foot = map(ring)[3];
      return { cx: foot.x, cy: foot.y, r: size * 0.045 };
    }),
    body: catmullRomPath(map(profile.outline), true),
    belly: catmullRomPath(map(profile.belly), true),
    plates: plates.map((poly) => polygonPath(map(poly))),
    frill: profile.frill ? polygonPath(map(frillFan(profile.frill))) : null,
    horns: (profile.horns ?? []).map((h) => polygonPath(map(h))),
    arms: (profile.arms ?? []).map((a) => catmullRomPath(map(a), true)),
    spots: dino.spots.map((s) => {
      const c = P(s.u, s.v);
      return { cx: c.x, cy: c.y, r: s.r * size };
    }),
    eye: { cx: eye.x, cy: eye.y, r: eyeR },
    glint: { cx: eye.x - facing * eyeR * 0.35, cy: eye.y - eyeR * 0.35, r: eyeR * 0.4 },
    smile: (() => {
      const pts = map(profile.smile);
      return catmullRomPath(pts, false);
    })(),
  };
}
