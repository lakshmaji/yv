// Animals in the water: whales, dolphins and sea turtles, placed and drawn.
//
// This replaces the abstract tone patches that used to fill the open sea. Those
// answered "is this water" with texture; a whale answers it with a subject. A
// blank sea around a busy island reads as a margin, and the eye skips a margin —
// something living in it is what makes the water part of the picture rather than
// the background it is painted on.
//
// Drawn from *above*, unlike the dinosaurs, which are in profile. Same reasoning
// as the drone: this is a sea surface seen from overhead, a fluke is horizontal on
// a real whale, and a shell with four flippers is the silhouette everyone
// recognises as a turtle. In profile, three animals in the water would look like
// three animals standing on it.
//
// Pure and data-only, like lib/dino.ts and lib/landscape/world.ts: nothing here
// touches the DOM or Math.random, so placement and geometry are covered by the
// node-only vitest environment and the component is a thin projection.

import {
  catmullRomPath,
  centroid,
  insetPolygon,
  polygonPath,
  pointInPolygon,
  type Pt,
} from './geometry';
import { makeRng, type Rng } from './rng';

export type SeaKind = 'whale' | 'dolphin' | 'turtle';

export const SEA_KINDS: readonly SeaKind[] = ['whale', 'dolphin', 'turtle'];

/**
 * Colours per kind.
 *
 * Literals here rather than in `LAND`, for the reason `DRONE_VARIANTS` gives: a
 * kind is a *set* of colours, and a set split across two files drifts. They are
 * pitched to sit on dark water — a whale in true whale-grey vanishes into the sea
 * it is swimming in, so every back is lifted well clear of `waterDeep`.
 */
export interface SeaColors {
  /** The silhouette. */
  body: string;
  /** Fins, flukes and shell plates: the darker detail that reads at a glance. */
  dark: string;
  /** Sunlit back, offset toward the light like every other highlight here. */
  light: string;
  /** Skin at the head and limbs, where it differs from the body. */
  skin: string;
}

const COLORS: Record<SeaKind, SeaColors> = {
  whale: { body: '#3f6b9c', dark: '#284a72', light: '#7fa8ce', skin: '#3f6b9c' },
  dolphin: { body: '#7ba5c9', dark: '#4d7397', light: '#c2dcf0', skin: '#7ba5c9' },
  turtle: { body: '#57996a', dark: '#2f6a46', light: '#8ecb8c', skin: '#c8b478' },
};

/**
 * One stop on a creature's circuit, as an offset from where it is drawn.
 *
 * Offsets rather than absolute points, for the reason `dronePatrol` gives: the
 * travel is a transform, so with animation off it resolves to none and an animal
 * authored in absolute coordinates would park at the map's origin instead of in
 * the sea. `turn` is unwrapped — it runs past 360° round a lap rather than
 * wrapping to 0 — or the animal would spin on the spot at the seam.
 */
export interface SeaStop {
  dx: number;
  dy: number;
  /** Degrees, relative to the heading the creature is drawn at. */
  turn: number;
}

export interface SeaCreature {
  kind: SeaKind;
  /** Where the body is drawn, and where it sits with animation off. */
  x: number;
  y: number;
  /** One normalised unit, in px — roughly half the body's length. */
  size: number;
  /** Radians. 0 swims towards +x; the whole figure rotates with it. */
  heading: number;
  /**
   * The circuit, first stop first and closing back on it.
   *
   * A real lap of the island, not a glide in place: the animals are the only
   * thing in the water that goes anywhere, and a whale that bobbed on the spot
   * for a minute would read as a rock.
   */
  route: SeaStop[];
  /** Seconds for one lap. */
  dur: number;
  /**
   * Seconds per tail beat.
   *
   * Its own clock, not a fraction of the lap: a lap is minutes long, and a fluke
   * geared to it would beat once a minute. Bigger animals beat slower, which is
   * both true and what makes a whale read as heavy next to a dolphin.
   */
  beat: number;
  /**
   * Seconds between porpoise leaps, or 0 for an animal that stays in the water.
   *
   * Its own clock again, and a long one: a dolphin that jumped every other second
   * would be a toy. Long enough that a leap is an event you catch rather than a
   * loop you watch.
   */
  leap: number;
  /** 0–1, so no two animals are at the same point of their lap. */
  phase: number;
  colors: SeaColors;
}

/* ---------------------------------------------------------------------------- *
 * Anatomy.
 *
 * Authored in normalised units with u along the body (+ = nose) and v across it,
 * then rotated by `heading` and scaled by `size`. Every body is authored as its
 * +v half and mirrored, so a creature cannot end up subtly lopsided through a
 * mistyped coordinate — and the symmetry is a property a test can state.
 * ---------------------------------------------------------------------------- */

type UV = readonly [number, number];

/**
 * Closes a half-outline into a symmetric ring.
 *
 * The half runs nose-to-tail along +v; the mirror is walked back tail-to-nose
 * along -v. Points sitting on the axis are skipped on the way back, or the ring
 * would double up on them and the smoothing would tie a knot there.
 */
function mirrorRing(half: readonly UV[]): UV[] {
  const ring: UV[] = [...half];
  for (let i = half.length - 1; i >= 0; i--) {
    const [u, v] = half[i];
    if (v === 0) continue;
    ring.push([u, -v]);
  }
  return ring;
}

/** A regular hexagon, for the plates of a carapace. */
function hexagon(u: number, v: number, r: number): UV[] {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return [u + Math.cos(a) * r, v + Math.sin(a) * r * 0.9] as UV;
  });
}

/**
 * A scalloped carapace rim.
 *
 * Alternating radius, not a smooth oval: the marginal scutes are the thing that
 * says turtle rather than beetle, and an even ellipse with plates drawn inside it
 * reads as a ladybird from map distance.
 */
function carapace(rx: number, ry: number, scutes: number): UV[] {
  const steps = scutes * 2;
  return Array.from({ length: steps }, (_, i) => {
    const a = (Math.PI * 2 * i) / steps;
    const k = i % 2 === 0 ? 1 : 0.9;
    return [Math.cos(a) * rx * k, Math.sin(a) * ry * k] as UV;
  });
}

interface Profile {
  /** Half-outline of the body, nose to tail, v >= 0. Mirrored into a ring. */
  half: readonly UV[];
  /**
   * The after-body, hinged at `flexPivot` — everything behind the shoulders.
   *
   * Drawn *under* the main outline with an overlap, so the join is covered the
   * way the fluke's join already is. Without this the body is one rigid plank and
   * only the fluke moves, which reads as a heartbeat at the tail rather than as
   * swimming: a cetacean drives itself with a wave running the length of it.
   */
  flexHalf?: readonly UV[];
  flexPivot?: UV;
  /** Tail fluke, authored as a half and mirrored. Turtles have none. */
  flukeHalf?: readonly UV[];
  /** Where the fluke pivots — the peduncle, in body units. */
  flukePivot?: UV;
  /** Side limbs, authored on +v and mirrored across the axis by the shape fn. */
  fin?: readonly UV[];
  /** Where a limb pivots, on the +v side. */
  finPivot?: UV;
  /** Dorsal fin, seen edge-on from above: a lens along the midline. */
  dorsal?: readonly UV[];
  /** Carapace rim and its plates. */
  shell?: readonly UV[];
  plates?: readonly (readonly UV[])[];
  /** Head, for a creature whose head is not part of the body outline. */
  head?: readonly UV[];
  /** Stub tail, for the turtle. */
  tail?: readonly UV[];
  /** Eyes, on +v — mirrored, so both sides of a top-down animal have one. */
  eye?: UV;
  eyeR?: number;
  /** Blowhole, and therefore where the spout comes from. */
  blowhole?: UV;
  /**
   * Whether this animal porpoises — leaves the water in an arc and comes back
   * down with a splash. Dolphins do; a whale surfaces and a turtle does not.
   */
  leaps?: boolean;
  /** Half-extents of the surface ripple the animal sits in. */
  ripple: UV;
}

// Blunt head, broad shoulders, long taper to a wide fluke. Read from above the
// whale is mostly one big teardrop, and the pectorals are what stop it being a
// fish: they are set well forward and swept back.
const WHALE: Profile = {
  // The forebody only — head and shoulders. The rest is the flex section, so the
  // outline stops just behind the flippers and the two overlap at the hinge.
  half: [[0.9, 0.0], [0.88, 0.3], [0.78, 0.44], [0.44, 0.52], [0.06, 0.5], [-0.22, 0.42]],
  // Narrower than the forebody where it hinges, so at rest it is hidden inside
  // it and only emerges aft. Author it wider and the joint shows as a shoulder
  // step every time the tail swings.
  flexHalf: [[0.0, 0.36], [-0.26, 0.4], [-0.56, 0.26], [-0.88, 0.05]],
  flexPivot: [0.0, 0.0],
  // Wide and short, on a thin peduncle. This is the one line between a whale and
  // a fish from above: a caudal fin is a narrow V behind a spindle, flukes are a
  // broad pair of wings — wider than the body they are attached to.
  flukeHalf: [[-0.86, 0.05], [-1.0, 0.46], [-1.16, 0.84], [-1.06, 0.3], [-0.98, 0.0]],
  flukePivot: [-0.86, 0.0],
  fin: [[0.38, 0.44], [0.16, 0.72], [-0.06, 0.88], [0.06, 0.62], [0.24, 0.42]],
  finPivot: [0.36, 0.42],
  eye: [0.78, 0.3],
  eyeR: 0.05,
  blowhole: [0.6, 0.0],
  ripple: [1.05, 0.66],
};

// Everything the whale is not: a rostrum, a waist, and a fluke small enough that
// the body is clearly the fast part.
const DOLPHIN: Profile = {
  half: [
    // The beak, then the flare of the melon behind it. Without that step the
    // snout smooths into a taper and the animal is a fish.
    [1.16, 0.0], [1.08, 0.06], [0.94, 0.08], [0.84, 0.2],
    [0.4, 0.27], [0.02, 0.26], [-0.24, 0.2],
  ],
  flexHalf: [[-0.06, 0.17], [-0.32, 0.19], [-0.62, 0.12], [-0.9, 0.05]],
  flexPivot: [-0.06, 0.0],
  flukeHalf: [[-0.9, 0.04], [-1.04, 0.28], [-1.2, 0.5], [-1.12, 0.18], [-1.02, 0.0]],
  flukePivot: [-0.9, 0.0],
  fin: [[0.44, 0.22], [0.24, 0.52], [0.04, 0.64], [0.16, 0.38], [0.3, 0.22]],
  finPivot: [0.42, 0.22],
  dorsal: [[0.16, 0.0], [-0.02, 0.05], [-0.26, 0.0], [-0.02, -0.05]],
  eye: [0.68, 0.16],
  eyeR: 0.04,
  leaps: true,
  ripple: [1.0, 0.5],
};

// A shell with a head and four paddles. The front pair are much the larger, which
// is both true and what makes the animal look like it is rowing rather than
// drifting.
const TURTLE: Profile = {
  half: [[0.62, 0.0], [0.3, 0.36], [-0.1, 0.4], [-0.5, 0.26], [-0.66, 0.0]],
  shell: carapace(0.66, 0.58, 9),
  plates: [
    hexagon(0.24, 0, 0.17),
    hexagon(-0.02, 0, 0.18),
    hexagon(-0.3, 0, 0.16),
    hexagon(0.12, 0.34, 0.14),
    hexagon(-0.2, 0.32, 0.13),
    hexagon(0.12, -0.34, 0.14),
    hexagon(-0.2, -0.32, 0.13),
  ],
  head: [[0.6, 0.14], [0.82, 0.13], [0.96, 0.06], [0.96, -0.06], [0.82, -0.13], [0.6, -0.14]],
  // A paddle with width, not a sliver: the flippers have to clear the shell or
  // the animal is a rock with a head. Authored as a leaf — leading edge out to
  // the tip, trailing edge back to a root set further aft.
  fin: [[0.26, 0.38], [0.62, 0.66], [0.92, 0.9], [0.8, 0.56], [0.44, 0.26]],
  finPivot: [0.3, 0.36],
  tail: [[-0.6, 0.06], [-0.74, 0.0], [-0.6, -0.06]],
  eye: [0.88, 0.07],
  eyeR: 0.035,
  ripple: [0.9, 0.8],
};

const PROFILES: Record<SeaKind, Profile> = { whale: WHALE, dolphin: DOLPHIN, turtle: TURTLE };

/** Rear limbs are the front pair, shrunk and moved aft. Turtles only. */
const REAR_FIN_SCALE = 0.62;
const REAR_FIN_SHIFT = -0.72;

/** Half-stroke of a limb, in degrees. */
const FRONT_AMP = 9;
const REAR_AMP = 5;

/* ---------------------------------------------------------------------------- *
 * Geometry.
 * ---------------------------------------------------------------------------- */

export interface Dot {
  cx: number;
  cy: number;
  r: number;
}

export interface Blob {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Degrees, so the ellipse lies along the body rather than along the frame. */
  angle: number;
}

/**
 * One limb, with its own pivot and stroke.
 *
 * The stroke lives on the limb rather than in the component because it differs
 * per limb: a turtle's back legs kick shallower than its front ones and on the
 * opposite beat, which is the gait, and a component looping over paths cannot
 * know that from an index.
 */
export interface SeaFin {
  d: string;
  /** Where it hinges, in world coordinates. */
  pivot: Pt;
  /** Half the stroke, in degrees. */
  amp: number;
  /** Which way it swings, so a pair strokes outward together. */
  dir: 1 | -1;
  /** True for a turtle's back legs: shallower, and half a beat behind. */
  trailing: boolean;
}

export interface SeaShape {
  /** Faint disc of disturbed water the animal sits in. Still — see the CSS. */
  ripple: Blob;
  /** Arcs trailing astern, outermost last. Never a closed ring — see WAKE_ARCS. */
  wake: string[];
  /** The single silhouette. */
  body: string;
  /** Sunlit back — an ellipse offset toward the light, as the lakes are. */
  gloss: Blob;
  /**
   * The after-body, and the shoulder it hinges at. Drawn under the silhouette
   * with the fluke inside it, so the fluke's beat rides on the body's wave
   * instead of competing with it.
   */
  flex: string | null;
  flexPivot: Pt;
  /** Tail fluke, and the point it pivots about when it beats. */
  fluke: string | null;
  flukePivot: Pt;
  /** Limbs, front pair first. Each carries what it needs to be animated. */
  fins: SeaFin[];
  dorsal: string | null;
  shell: string | null;
  plates: string[];
  head: string | null;
  tail: string | null;
  eyes: Dot[];
  /**
   * Spray thrown when it comes back down, for an animal that leaves the water: a
   * ring at the entry point and a scatter of droplets around it. Null for
   * anything that stays in.
   */
  splash: { ring: Blob; drops: Dot[] } | null;
  /**
   * Shadow the animal casts on the water while it is above it — the cue that
   * says a top-down figure has left the surface, since from up here a leap has
   * no height of its own to show. Offset away from the light, like every other
   * shadow on this map.
   */
  airShadow: Blob | null;
  /**
   * The blow, as the ring of spray it makes seen from above — null for anything
   * without a blowhole.
   *
   * A ring rather than a plume: the plume is going straight at the viewer from up
   * here, so what there is to draw is the disturbance around it. A scatter of
   * droplets was the first attempt and read as polka dots on the animal's head.
   */
  spout: Dot | null;
}

/** Direction the map is lit from, matching the terrain and the lake highlights. */
const LIGHT: Pt = { x: -0.7071, y: -0.7071 };

/** Radius of the splash ring a blow throws, in body units. */
const SPOUT_R = 0.17;

/** Droplets thrown by an animal coming back down. */
const SPLASH_DROPS = 7;

/**
 * The wake: arcs of disturbed water falling behind a swimmer.
 *
 * Arcs *behind*, never rings around. Complete rings expanding out of a stationary
 * animal is a sonar ping — or, as it actually read on the map, a heartbeat: the
 * shape is symmetric, so nothing about it says which way the animal is going, and
 * all that is left to see is the throb. A wake is one-sided by definition, and
 * that asymmetry is the whole difference between "this thing is pulsing" and
 * "this thing is moving".
 *
 * Centred on the body so the arcs are concentric with each other, spanning the
 * rear only, and spread over their cycle so one is always going out.
 */
const WAKE_ARCS = 3;
const WAKE_R0 = 0.72;
const WAKE_STEP = 0.16;
/** Half-angle either side of dead astern. */
const WAKE_SPREAD = (64 * Math.PI) / 180;
const WAKE_STEPS = 8;
/** How far the outermost arc has travelled by the end of its cycle. */
export const WAKE_SCALE = 1.2;
/** Reach of the furthest wake arc, in units of the ripple's own half-extents. */
export const WAKE_REACH = (WAKE_R0 + WAKE_STEP * (WAKE_ARCS - 1)) * WAKE_SCALE;

function mapper(c: SeaCreature): (u: number, v: number) => Pt {
  const cos = Math.cos(c.heading);
  const sin = Math.sin(c.heading);
  return (u, v) => ({
    x: c.x + (u * cos - v * sin) * c.size,
    y: c.y + (u * sin + v * cos) * c.size,
  });
}

/** A limb moved aft and shrunk about its own root — the turtle's back paddles. */
function rearFin(fin: readonly UV[]): UV[] {
  const [ru, rv] = fin[0];
  return fin.map(([u, v]) => [
    ru + REAR_FIN_SHIFT + (u - ru) * REAR_FIN_SCALE,
    rv + (v - rv) * REAR_FIN_SCALE,
  ] as UV);
}

/**
 * Absolute SVG geometry for one creature.
 *
 * Limbs and eyes are authored on one side and mirrored here rather than in the
 * tables, so the pair can never disagree — the same reason the outline is built
 * from a half.
 */
export function seaShape(c: SeaCreature): SeaShape {
  const P = mapper(c);
  const map = (pts: readonly UV[]): Pt[] => pts.map(([u, v]) => P(u, v));
  const flip = (pts: readonly UV[]): UV[] => pts.map(([u, v]) => [u, -v] as UV);
  const profile = PROFILES[c.kind];

  const fins: SeaFin[] = [];
  if (profile.fin) {
    const [pu, pv] = profile.finPivot ?? profile.fin[0];
    [profile.fin, flip(profile.fin)].forEach((side, i) => {
      fins.push({
        d: polygonPath(map(side)),
        pivot: P(pu, i === 0 ? pv : -pv),
        amp: FRONT_AMP,
        dir: i === 0 ? 1 : -1,
        trailing: false,
      });
    });
    // A turtle rows with four, and the back pair are on the opposite beat — that
    // diagonal gait is most of what makes one look like it is swimming rather
    // than being carried. Shallower, because they mostly steer.
    if (c.kind === 'turtle') {
      const rear = rearFin(profile.fin);
      const ru = pu + REAR_FIN_SHIFT;
      [rear, flip(rear)].forEach((side, i) => {
        fins.push({
          d: polygonPath(map(side)),
          pivot: P(ru, i === 0 ? pv : -pv),
          amp: REAR_AMP,
          dir: i === 0 ? -1 : 1,
          trailing: true,
        });
      });
    }
  }

  const eyes: Dot[] = [];
  if (profile.eye) {
    const [eu, ev] = profile.eye;
    const r = (profile.eyeR ?? 0.04) * c.size;
    for (const p of [P(eu, ev), P(eu, -ev)]) eyes.push({ cx: p.x, cy: p.y, r });
  }

  let spout: Dot | null = null;
  if (profile.blowhole) {
    const hole = P(profile.blowhole[0], profile.blowhole[1]);
    spout = { cx: hole.x, cy: hole.y, r: SPOUT_R * c.size };
  }

  const deg = (c.heading * 180) / Math.PI;
  const [rx, ry] = profile.ripple;

  let splash: SeaShape['splash'] = null;
  let airShadow: Blob | null = null;
  if (profile.leaps) {
    splash = {
      // Flattened along the body and lying with it: this is water at the surface,
      // and a true circle would read as a hoop the animal is jumping through.
      ring: { cx: c.x, cy: c.y, rx: rx * c.size * 0.72, ry: ry * c.size * 0.85, angle: deg },
      // Thrown clear of the ring, not sitting on it. Uneven angles and sizes:
      // evenly spaced droplets read as a flower, the trap the whale's blow fell
      // into on the first pass.
      drops: Array.from({ length: SPLASH_DROPS }, (_, i) => {
        const a = (Math.PI * 2 * i) / SPLASH_DROPS + (i % 2 === 0 ? 0.35 : -0.2);
        const reach = rx * c.size * (i % 3 === 0 ? 1.4 : 1.05);
        return {
          cx: c.x + Math.cos(a) * reach,
          cy: c.y + Math.sin(a) * reach * 0.72,
          r: c.size * (i % 2 === 0 ? 0.11 : 0.075),
        };
      }),
    };
    // Well clear of the body: a shadow the animal is still standing on says
    // nothing, and separation is the only thing here that reads as height.
    airShadow = {
      cx: c.x - LIGHT.x * c.size * 1.0,
      cy: c.y - LIGHT.y * c.size * 1.0,
      rx: 0.9 * c.size,
      ry: 0.3 * c.size,
      angle: deg,
    };
  }

  // Concentric arcs across the stern. Elongated across the body rather than
  // along it, because a wake spreads sideways as it is left behind.
  const wake = Array.from({ length: WAKE_ARCS }, (_, i) => {
    const reach = WAKE_R0 + WAKE_STEP * i;
    const pts: Pt[] = [];
    for (let k = 0; k <= WAKE_STEPS; k++) {
      const a = Math.PI - WAKE_SPREAD + (2 * WAKE_SPREAD * k) / WAKE_STEPS;
      pts.push(P(Math.cos(a) * rx * reach, Math.sin(a) * ry * reach * 1.15));
    }
    return catmullRomPath(pts, false);
  });

  return {
    ripple: {
      cx: c.x,
      cy: c.y,
      rx: rx * c.size * 1.18,
      ry: ry * c.size * 1.5,
      angle: deg,
    },
    wake,
    body: catmullRomPath(map(mirrorRing(profile.half)), true),
    gloss: {
      // Offset toward the light rather than centred, so the back has a lit side.
      // The lakes learned this: a centred highlight is a sticker, not a surface.
      cx: c.x + LIGHT.x * c.size * 0.16,
      cy: c.y + LIGHT.y * c.size * 0.16,
      rx: (c.kind === 'turtle' ? 0.34 : 0.5) * c.size,
      ry: (c.kind === 'turtle' ? 0.26 : 0.17) * c.size,
      angle: deg,
    },
    flex: profile.flexHalf ? catmullRomPath(map(mirrorRing(profile.flexHalf)), true) : null,
    flexPivot: profile.flexPivot ? P(profile.flexPivot[0], profile.flexPivot[1]) : P(0, 0),
    fluke: profile.flukeHalf ? polygonPath(map(mirrorRing(profile.flukeHalf))) : null,
    flukePivot: profile.flukePivot ? P(profile.flukePivot[0], profile.flukePivot[1]) : P(0, 0),
    fins,
    dorsal: profile.dorsal ? polygonPath(map(profile.dorsal)) : null,
    shell: profile.shell ? catmullRomPath(map(profile.shell), true) : null,
    plates: (profile.plates ?? []).map((plate) => polygonPath(map(plate))),
    head: profile.head ? catmullRomPath(map(profile.head), true) : null,
    tail: profile.tail ? polygonPath(map(profile.tail)) : null,
    eyes,
    splash,
    airShadow,
    spout,
  };
}

/**
 * Every point the creature is drawn from, in world coordinates.
 *
 * This is the placement test, not a decoration: rejecting on the centre alone is
 * what put a whitecap's ends on the grass, and a whale is far bigger than a
 * whitecap. The ripple's corners are included because it is the widest thing
 * drawn, and the fluke because it is the furthest.
 */
export function seaHull(c: SeaCreature): Pt[] {
  const P = mapper(c);
  const profile = PROFILES[c.kind];
  const parts: UV[][] = [
    mirrorRing(profile.half),
    profile.flexHalf ? mirrorRing(profile.flexHalf) : [],
    profile.flukeHalf ? mirrorRing(profile.flukeHalf) : [],
    profile.head ? [...profile.head] : [],
    profile.tail ? [...profile.tail] : [],
    profile.shell ? [...profile.shell] : [],
  ];
  if (profile.fin) {
    const sides = [profile.fin, profile.fin.map(([u, v]) => [u, -v] as UV)];
    for (const side of sides) {
      parts.push([...side]);
      if (c.kind === 'turtle') parts.push(rearFin(side));
    }
  }
  const [rx, ry] = profile.ripple;
  parts.push([
    [rx, ry],
    [rx, -ry],
    [-rx, ry],
    [-rx, -ry],
  ]);
  // The furthest the wake gets, at the end of its cycle. Water it disturbs is
  // still something drawn on the map, and a wake washing over a beach is the
  // same defect as a fluke doing it.
  for (let k = 0; k <= WAKE_STEPS; k++) {
    const a = Math.PI - WAKE_SPREAD + (2 * WAKE_SPREAD * k) / WAKE_STEPS;
    parts.push([[Math.cos(a) * rx * WAKE_REACH, Math.sin(a) * ry * WAKE_REACH * 1.15]]);
  }
  return parts.flat().map(([u, v]) => P(u, v));
}


/* ---------------------------------------------------------------------------- *
 * Circuits and placement.
 * ---------------------------------------------------------------------------- */

/** How many of each kind are in the water. One whale: two is a pod, not a sea. */
export const SEA_COUNTS: Record<SeaKind, readonly [number, number]> = {
  whale: [1, 1],
  dolphin: [2, 3],
  turtle: [1, 2],
};

/** Size range per kind, in px per normalised unit. */
const SIZES: Record<SeaKind, readonly [number, number]> = {
  whale: [24, 31],
  dolphin: [17, 22],
  turtle: [11, 14],
};

/**
 * Cruising speed in px per second.
 *
 * A drift, not a journey. The first pass had a dolphin at 40 px/s, which crosses
 * the whole map in under a minute — on a still landscape that is not an animal
 * swimming, it is something being dragged across the picture, and it pulls the
 * eye off everything else.
 *
 * At these speeds an animal takes ten to twenty minutes to go round, so within any
 * one look it is holding station. The swimming is carried by the body and the
 * water instead: the flippers, the tail, and the wake rings going out from it. The
 * lap is only there so that the sea is not the same sea an hour later.
 */
const SPEED: Record<SeaKind, number> = { whale: 4, dolphin: 6, turtle: 2.5 };

/** Seconds per tail beat, before jitter. */
const BEAT: Record<SeaKind, number> = { whale: 3.4, dolphin: 1.5, turtle: 2.8 };

/** Seconds between leaps, before jitter. Only the porpoising kinds get one. */
const LEAP = 7.5;

/**
 * How much bigger the animal looks at the top of its arc.
 *
 * This is the whole of "height" here: from directly overhead a leap has no rise
 * to draw, so coming up toward the viewer is told by getting bigger, by the
 * shadow sliding out from under, and by the splash on the way back in.
 *
 * The leap deliberately does *not* carry the animal forward itself. It used to,
 * and a keyframe loop has to come back to where it started — so every jump was
 * followed by the dolphin sliding backwards to its take-off point. Forward travel
 * belongs to the lap, which only ever goes one way; the two are geared together
 * instead, one leap per leg of the circuit, so the animal surges while it is in
 * the air and never once moves backwards.
 */
export const LEAP_SCALE = 1.22;

/** Stops per lap. Enough that the turns are smooth on a lumpy coastline. */
export const SEA_STOPS = 36;

/**
 * Clearance from the shore, in px.
 *
 * The near bound keeps a circuit outside the surf collar (`SURF_REACH`) and the
 * broken water inside it, which is not where anything swims. The far bound keeps
 * the animals around the island: a lap out at the frame edge is off the picture
 * for most of its length.
 */
const MIN_OFFSHORE = 48;
const MAX_OFFSHORE = 110;

/**
 * How far, and in what steps, a pinched stop may be pushed further out.
 *
 * A radial offset of the coastline is not uniform on a lumpy shore — the caveat
 * `insetPolygon` documents — so a circuit that is comfortably offshore for most
 * of its length can still clip a headland at one or two stops. Rejecting the
 * whole lap for that would mean almost no lap ever passes, since one bad stop in
 * thirty-six is close to certain. Nudging the offender seaward keeps the circuit
 * and costs nothing visible: the route already wanders with the coast.
 *
 * Tried outward first, then inward at the same distance: a pinch is usually land
 * in the way, and the sea is on the far side of it — but on a shore that runs
 * close to the frame the obstacle is the *edge*, and there the water is back
 * toward the island.
 */
const RELAX_STEP = 14;
const RELAX_STEPS = 10;

/**
 * Offsets tried before a kind gives up on this slot.
 *
 * The whale is the one that needs them: it has by far the largest hull, so the
 * band of offsets whose whole lap clears both the shore and the frame is narrow,
 * and a handful of tries used to lose it on about a third of the islands. Losing
 * the whale is the worst single outcome here — it is the animal the sea is for.
 */
const ATTEMPTS = 40;

/** Closest two animals may start, in px. */
const MIN_GAP = 150;

/** Margin inside the frame, so nothing is drawn half off the edge. */
const FRAME_PAD = 8;

/**
 * Whether every point the animal is drawn from is in open sea.
 *
 * Being outside the coast ring is the whole test for "not on land": the rivers
 * and the lakes are inside it by construction, so an animal that clears the
 * coastline cannot be swimming up an estuary or sitting in a tarn. Islets are
 * separate rings and are checked on their own.
 *
 * Applied to every stop of the circuit, not just the one the creature is drawn
 * at — a lap is a promise about the whole route, and a whale that clips the beach
 * two minutes in is the same bug as one that starts there.
 */
function inOpenSea(
  c: SeaCreature,
  coast: readonly Pt[],
  islets: readonly Pt[][],
  width: number,
  height: number,
): boolean {
  // A leaper is drawn LEAP_SCALE bigger at the top of its arc, so it is checked
  // at that size too: a fluke tip that clears the shore at rest can be over the
  // beach when the animal is up in the air.
  const scales = c.leap > 0 ? [1, LEAP_SCALE] : [1];

  for (const p of seaHull(c)) {
    for (const scale of scales) {
      const q = { x: c.x + (p.x - c.x) * scale, y: c.y + (p.y - c.y) * scale };
      if (q.x < FRAME_PAD || q.x > width - FRAME_PAD) return false;
      if (q.y < FRAME_PAD || q.y > height - FRAME_PAD) return false;
      if (pointInPolygon(q, coast)) return false;
      if (islets.some((ring) => pointInPolygon(q, ring))) return false;
    }
  }
  return true;
}

/** Perimeter of a closed ring. */
function perimeter(ring: readonly Pt[]): number {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/**
 * A closed circuit `offset` px outside the coast, resampled to `SEA_STOPS`.
 *
 * The coastline offset outward, rather than a circle around the island: a circle
 * big enough to clear a wide island leaves the frame at the ends, and one small
 * enough to stay in frame cuts through the middle of it. Following the shore also
 * means the animals swim *around* the place, which is the thing being drawn.
 *
 * Radial offset from the centroid, with the caveat `insetPolygon` documents and
 * the swell rings already live with: the spacing is not perfectly uniform on a
 * lumpy coast. That is fine here — every stop is checked against the actual
 * coastline afterwards, so an offset that pinches simply fails and a smaller one
 * is tried.
 */
function circuit(coast: readonly Pt[], offset: number): Pt[] {
  const ring = insetPolygon(coast, -offset);
  const step = ring.length / SEA_STOPS;
  return Array.from({ length: SEA_STOPS }, (_, i) => {
    const at = i * step;
    const lo = Math.floor(at) % ring.length;
    const hi = (lo + 1) % ring.length;
    const t = at - Math.floor(at);
    return {
      x: ring[lo].x + (ring[hi].x - ring[lo].x) * t,
      y: ring[lo].y + (ring[hi].y - ring[lo].y) * t,
    };
  });
}

/** Heading at stop `i` of a closed circuit: the direction of travel there. */
function headingAt(ring: readonly Pt[], i: number, dir: 1 | -1): number {
  const ahead = ring[(i + dir + ring.length) % ring.length];
  const behind = ring[(i - dir + ring.length) % ring.length];
  return Math.atan2(ahead.y - behind.y, ahead.x - behind.x);
}

/**
 * The lap as offsets and turns from the first stop.
 *
 * The turn is unwrapped as it goes, so a lap accumulates a full ±360° instead of
 * jumping the short way round at the seam. The closing stop repeats the first
 * position at exactly ±360°, which is the same pose — so the loop is seamless
 * without the animation having to interpolate backwards through the turn.
 */
function toStops(ring: readonly Pt[], start: number, dir: 1 | -1, base: number): SeaStop[] {
  const stops: SeaStop[] = [];
  let previous = base;
  let unwrapped = 0;

  for (let k = 0; k <= ring.length; k++) {
    const i = (start + dir * k + ring.length * 2) % ring.length;
    const heading = k === ring.length ? base : headingAt(ring, i, dir);
    // Shortest step from the previous heading, then accumulated: two consecutive
    // stops are never more than a few degrees apart, so this cannot alias.
    let delta = heading - previous;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    unwrapped += delta;
    previous = heading;
    stops.push({
      dx: ring[i].x - ring[start].x,
      dy: ring[i].y - ring[start].y,
      turn: (unwrapped * 180) / Math.PI,
    });
  }
  return stops;
}

/**
 * Pushes any stop that is not in open water further out until it is.
 *
 * Returns null when a stop cannot be saved within `RELAX_STEPS` — a channel too
 * narrow for the animal, or a frame edge in the way — in which case the caller
 * tries a different offset rather than drawing something aground.
 */
function relax(
  ring: readonly Pt[],
  dir: 1 | -1,
  proto: SeaCreature,
  coast: readonly Pt[],
  islets: readonly Pt[][],
  width: number,
  height: number,
): Pt[] | null {
  const middle = centroid(coast);
  const out: Pt[] = [];

  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const heading = headingAt(ring, i, dir);
    const len = Math.hypot(p.x - middle.x, p.y - middle.y) || 1;
    const ux = (p.x - middle.x) / len;
    const uy = (p.y - middle.y) / len;

    let fixed: Pt | null = null;
    for (let k = 0; k <= RELAX_STEPS && !fixed; k++) {
      for (const sign of k === 0 ? [1] : [1, -1]) {
        const reach = k * RELAX_STEP * sign;
        const q = { x: p.x + ux * reach, y: p.y + uy * reach };
        if (inOpenSea({ ...proto, x: q.x, y: q.y, heading }, coast, islets, width, height)) {
          fixed = q;
          break;
        }
      }
    }
    if (!fixed) return null;
    out.push(fixed);
  }
  return out;
}

export interface SwimFrame {
  offset: number;
  transform: string;
  easing: string;
}

/**
 * Keyframes for one lap, for `element.animate()`.
 *
 * A script animation for the same reason the drone's route is one: the stops are
 * data, and a static `@keyframes` rule could only reach them through custom
 * properties, which pins the stop count and puts the circuit somewhere no test
 * can see it. The cost is that CSS cannot cancel it, so the component honours the
 * motion toggle and the OS setting itself.
 *
 * Linear easing, unlike the drone's per-stop settle: a swimming animal holds its
 * speed, and easing into every waypoint would make it lollop.
 */
export function swimFrames(c: SeaCreature): SwimFrame[] {
  const stops = c.route;
  if (stops.length < 2) return [];
  return stops.map((stop, i) => ({
    offset: i / (stops.length - 1),
    transform: `translate(${stop.dx.toFixed(2)}px, ${stop.dy.toFixed(2)}px) rotate(${stop.turn.toFixed(2)}deg)`,
    // A porpoising animal does not cruise: it drives itself forward in the arc
    // and coasts between. Easing each leg turns the lap into that — one surge per
    // leg, and a leg is one leap. Everything else holds its speed, because
    // easing into every waypoint would make a whale lollop.
    easing: c.leap > 0 ? 'ease-in-out' : 'linear',
  }));
}

function build(kind: SeaKind, at: Pt, heading: number, rng: Rng): SeaCreature {
  const [minSize, maxSize] = SIZES[kind];
  const size = rng.range(minSize, maxSize);
  return {
    kind,
    x: at.x,
    y: at.y,
    size,
    heading,
    route: [],
    dur: 0,
    beat: BEAT[kind] * rng.range(0.88, 1.14),
    leap: PROFILES[kind].leaps ? LEAP * rng.range(0.8, 1.35) : 0,
    phase: rng.next(),
    colors: COLORS[kind],
  };
}

/**
 * The animals in the sea around an island, seeded so a given world always has the
 * same ones — the map is regenerated from a visible seed, and a sea that
 * reshuffled on every render would be the one part of it that could not be
 * reproduced from that number.
 *
 * Each animal is placed *on* a circuit rather than at a free point that is then
 * given one. Placing first and routing second means a perfectly good position can
 * turn out to have no lap that stays at sea, and the animal is then either
 * dropped or left bobbing — this way the lap is the thing being searched for, and
 * a creature that exists has one by construction.
 *
 * A fixed attempt budget, so an island that leaves almost no open water yields
 * fewer animals instead of spinning.
 */
export function seaLife(
  coast: readonly Pt[],
  islets: readonly Pt[][],
  width: number,
  height: number,
  seed: number,
): SeaCreature[] {
  if (coast.length < 3) return [];
  const rng = makeRng(seed ^ 0x5ea11fe);
  const placed: SeaCreature[] = [];

  for (const kind of SEA_KINDS) {
    const [lo, hi] = SEA_COUNTS[kind];
    const want = rng.int(lo, hi);

    for (let n = 0; n < want; n++) {
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const offset = rng.range(MIN_OFFSHORE, MAX_OFFSHORE);
        const ring = circuit(coast, offset);
        const dir: 1 | -1 = rng.chance(0.5) ? 1 : -1;
        const start = rng.int(0, ring.length - 1);
        if (placed.some((o) => Math.hypot(o.x - ring[start].x, o.y - ring[start].y) < MIN_GAP)) {
          continue;
        }

        const proto = build(kind, ring[start], headingAt(ring, start, dir), rng);

        const lap = relax(ring, dir, proto, coast, islets, width, height);
        if (!lap) continue;

        // Checked again on the relaxed ring, because nudging a stop changed its
        // neighbours' headings — and a hull tested at one heading says nothing
        // about the same hull swung ninety degrees. The tight spots on a lap are
        // exactly the corners.
        const clear = lap.every((p, i) =>
          inOpenSea(
            { ...proto, x: p.x, y: p.y, heading: headingAt(lap, i, dir) },
            coast,
            islets,
            width,
            height,
          ),
        );
        if (!clear) continue;

        const creature = proto;
        creature.x = lap[start].x;
        creature.y = lap[start].y;
        creature.heading = headingAt(lap, start, dir);
        creature.route = toStops(lap, start, dir, creature.heading);
        // A leaper covers exactly one leg of the circuit per leap, so the surge
        // in `swimFrames` lands under the arc. Everything else just cruises.
        creature.dur =
          creature.leap > 0 ? creature.leap * SEA_STOPS : perimeter(lap) / SPEED[kind];
        placed.push(creature);
        break;
      }
    }
  }

  return placed;
}
