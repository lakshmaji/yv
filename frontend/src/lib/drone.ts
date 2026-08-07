// Survey drone for the Discovery map.
//
// One quadcopter flies a closed circuit over the island while the app looks for
// nearby devices. With nothing found it sweeps open ground; once devices are
// there — each drawn as a dinosaur — the circuit is re-planned to visit them,
// dipping toward each animal as it passes.
//
// Pure and data-only, like lib/dino.ts and lib/landscape/world.ts: nothing here
// touches the DOM or Math.random, so the whole route is covered by the node-only
// vitest environment and the component is a thin projection.
//
// Unlike `randomDino`, this never gives up and returns null. The drone *is* the
// scanning indicator, so a world where no sampled point is acceptable still gets
// a circuit — a plain ring inside the bounds.

import { hashText, makeRng, type Rng } from './landscape/rng';
import { centroid, dist, type Pt } from './landscape/geometry';
import type { Insets, Rect } from './viewbox';

/**
 * Waypoints per lap. Fixed, because every stop is a keyframe: the route is
 * turned into an explicit list of transforms, and holding the count steady keeps
 * that list — and the tests over it — a known shape.
 */
export const PATROL_STOPS = 8;

/** Waypoints come in pairs, one pair per stop on the circuit. */
export const PATROL_SLOTS = PATROL_STOPS / 2;

/**
 * How many dinosaurs one lap visits.
 *
 * A lap has four slots, and a lap that tried to visit nine devices would spend
 * so little time near each that the dip would not read at all. Beyond this the
 * drone visits the first few and the rest are simply overflown.
 */
export const MAX_VISITS = PATROL_SLOTS;

/** Cruise height above a dinosaur's feet, and the height it drops to. */
const HOVER_H = 96;
const DIP_H = 44;

/** Horizontal offset of the approach and of the dip, so it arcs over the animal. */
const APPROACH_DX = 70;
const DIP_DX = 26;

/** Padding orbit: how far outside the herd the transit legs run. */
const ORBIT_MARGIN = 190;
const MIN_ORBIT_R = 170;

/** Viewbox units per second, and the lap length that implies. */
const SPEED = 46;
const MIN_DURATION = 16;
const MAX_DURATION = 64;

/** Candidate positions drawn before a survey circuit falls back to a ring. */
const SURVEY_SAMPLES = 240;

/** Degrees of tilt at full horizontal travel. */
export const MAX_BANK = 9;

/** One normalised unit of the drone, in px. */
export const DRONE_SIZE = 34;

/**
 * An airframe the user can pick from.
 *
 * The fleet exists so "send another drone" is a real choice rather than a reroll:
 * a hexacopter with six-blade fans is recognisably a different machine from the
 * little two-blade scout, not the same drawing in another colour. Colours are
 * literals here rather than in the map palette because a variant is a *set* of
 * them, and splitting the set across two files is how they drift apart.
 */
export interface DroneVariant {
  id: string;
  label: string;
  /** One line in the picker, so a choice is more than a shape. */
  blurb: string;
  /** 4 (X layout) or 6 (evenly spread). */
  rotors: 4 | 6;
  /** Blades per fan. Even, because a blade is drawn as a two-ended ellipse. */
  blades: 2 | 4 | 6;
  /** Hub distance from the airframe's centre, in units of `size`. */
  reach: number;
  /** Rotor disc radius, in units of `size`. */
  discR: number;
  /** Body half-extents, in units of `size`. */
  bodyW: number;
  bodyH: number;
  shell: string;
  shellDark: string;
  blade: string;
}

export const DRONE_VARIANTS: readonly DroneVariant[] = [
  {
    id: 'scout',
    label: 'Scout',
    blurb: 'Quad · 2-blade · light and quick',
    rotors: 4,
    blades: 2,
    reach: 1.07,
    discR: 0.42,
    bodyW: 0.4,
    bodyH: 0.34,
    shell: '#cfd8e0',
    shellDark: '#78838f',
    blade: '#e8eef4',
  },
  {
    id: 'surveyor',
    label: 'Surveyor',
    blurb: 'Quad · 4-blade · steady platform',
    rotors: 4,
    blades: 4,
    reach: 1.14,
    discR: 0.46,
    bodyW: 0.44,
    bodyH: 0.4,
    shell: '#9fc0dc',
    shellDark: '#4f6b85',
    blade: '#dff0fb',
  },
  {
    id: 'hauler',
    label: 'Hauler',
    blurb: 'Quad · 6-blade · heavy lifter',
    rotors: 4,
    blades: 6,
    reach: 1.2,
    discR: 0.5,
    bodyW: 0.5,
    bodyH: 0.44,
    shell: '#8d8f96',
    shellDark: '#4a4d54',
    blade: '#f0b45c',
  },
  {
    id: 'hexscout',
    label: 'Hex Scout',
    blurb: 'Hexa · 2-blade · wide sweep',
    rotors: 6,
    blades: 2,
    reach: 1.02,
    discR: 0.36,
    bodyW: 0.36,
    bodyH: 0.36,
    shell: '#bfeadf',
    shellDark: '#3f7f73',
    blade: '#eafaf5',
  },
  {
    id: 'courier',
    label: 'Courier',
    blurb: 'Hexa · 4-blade · long range',
    rotors: 6,
    blades: 4,
    reach: 1.1,
    discR: 0.4,
    bodyW: 0.42,
    bodyH: 0.38,
    shell: '#e5cfa8',
    shellDark: '#8a6a3f',
    blade: '#fff0d2',
  },
];

/** The airframe sent out when the user has not chosen one. */
export const DEFAULT_VARIANT = DRONE_VARIANTS[0];

/**
 * A variant by id, falling back to the default.
 *
 * Never throws: the id is persisted in settings, so a build that renamed or
 * dropped a variant would otherwise leave the map with no drone at all.
 */
export function variantById(id: string | undefined | null): DroneVariant {
  return DRONE_VARIANTS.find((v) => v.id === id) ?? DEFAULT_VARIANT;
}

/**
 * Rotor hub offsets from the airframe's centre, in units of `size`.
 *
 * A quad is an X with the front pair slightly wider than the rear, so the
 * aircraft has a nose from above — that is what lets the tilt read as banking
 * into a turn rather than as the whole drawing wobbling. A hexa is six evenly
 * spread, offset half a step so none of them sits dead ahead and hides the nose.
 */
export function rotorMounts(variant: DroneVariant): Pt[] {
  if (variant.rotors === 4) {
    return [
      { x: -0.8, y: -0.58 },
      { x: 0.8, y: -0.58 },
      { x: -0.75, y: 0.62 },
      { x: 0.75, y: 0.62 },
    ].map((m) => ({ x: m.x * variant.reach, y: m.y * variant.reach }));
  }
  return Array.from({ length: variant.rotors }, (_, i) => {
    const angle = (-90 + 30 + i * (360 / variant.rotors)) * (Math.PI / 180);
    return { x: Math.cos(angle) * variant.reach, y: Math.sin(angle) * variant.reach };
  });
}

/**
 * Blade angles for one fan, in degrees.
 *
 * A blade is drawn as a two-ended ellipse through the hub, so a 6-blade fan is
 * three ellipses 60° apart rather than six.
 */
export function bladeAngles(variant: DroneVariant): number[] {
  const spokes = variant.blades / 2;
  return Array.from({ length: spokes }, (_, i) => (i * 180) / spokes);
}

/** How far below the airframe the ground shadow is drawn, in units of `size`. */
const SHADOW_DROP = 2.3;
const SHADOW_RY = 0.17;

/**
 * How far a variant reaches from its centre, in units of `size`.
 *
 * Derived rather than declared, which is the point: the placement bounds are
 * inset by this, so a number that lagged the drawing would clip a rotor at the
 * panel edge exactly when the drone flew out there — and it is set by the rotor
 * discs and the tilt swing, not by the airframe, which is easy to get wrong by
 * hand. Down is by far the largest, because of the shadow.
 */
export function droneExtent(variant: DroneVariant = DEFAULT_VARIANT): Required<Insets> {
  const rad = (MAX_BANK * Math.PI) / 180;
  let side = 0;
  let up = 0;
  let down = 0;

  for (const mount of rotorMounts(variant)) {
    for (const sign of [1, -1]) {
      const x = mount.x * Math.cos(sign * rad) - mount.y * Math.sin(sign * rad);
      const y = mount.x * Math.sin(sign * rad) + mount.y * Math.cos(sign * rad);
      side = Math.max(side, Math.abs(x) + variant.discR);
      up = Math.max(up, -y + variant.discR);
      down = Math.max(down, y + variant.discR);
    }
  }

  // A little air, so a drone at the very edge of its bounds doesn't graze it.
  const pad = 0.08;
  return {
    left: side + pad,
    right: side + pad,
    top: up + pad,
    bottom: Math.max(down, SHADOW_DROP + SHADOW_RY) + pad,
  };
}

/**
 * Bounds insets that keep the whole drone — including the ground shadow it
 * drags along under itself — inside a rect.
 */
export function droneInsets(
  size = DRONE_SIZE,
  variant: DroneVariant = DEFAULT_VARIANT,
  /** The speech bubble, when one is showing — it reaches further than the rotors. */
  chat: ChatBubble | null = null,
): Required<Insets> {
  const extent = droneExtent(variant);
  const insets = {
    left: extent.left * size,
    right: extent.right * size,
    top: extent.top * size,
    bottom: extent.bottom * size,
  };
  if (!chat) return insets;

  // The bubble hangs off the top-right corner and is far wider than the
  // airframe, so on those two edges it — not the rotor disc — sets how close
  // the drone may fly. Without this the box clips off the side of the panel
  // whenever the drone visits a dinosaur near the right edge.
  return {
    ...insets,
    right: Math.max(insets.right, chat.x + chat.w),
    top: Math.max(insets.top, -chat.y),
  };
}

/** Matches the Discovery map's canvas, as lib/dino.ts does. */
export const DEFAULT_BOUNDS: Rect = { x: 0, y: 0, width: 1600, height: 900 };

export interface Drone {
  /**
   * Where the geometry is drawn, and where the drone sits with animation off.
   *
   * The circuit is expressed as offsets from here rather than as absolute
   * points, because the motion is a transform: with animation disabled the
   * transform resolves to none, and a drone authored at the viewBox origin
   * would park in the corner of the map instead of on the island.
   */
  origin: Pt;
  /** `PATROL_STOPS` offsets from `origin`. The first is always zero. */
  deltas: Pt[];
  /** Tilt in degrees at each stop, from the heading of the leg leaving it. */
  banks: number[];
  size: number;
  /** Seconds per lap, from the circuit's length. */
  duration: number;
  /** True when the route was planned around dinosaurs rather than open ground. */
  visiting: boolean;
  /** The airframe flying it. */
  variant: DroneVariant;
}

export interface DroneOptions {
  /** Where the drone may fly. Defaults to DEFAULT_BOUNDS. */
  bounds?: Rect;
  /** Seeds the survey sweep. Same seed and bounds give the same circuit. */
  seed?: number;
  /** Extra constraint on a survey waypoint, e.g. "must be over land". */
  allow?: (p: Pt) => boolean;
  /** Dinosaur positions to visit. Empty means "still searching". */
  targets?: readonly Pt[];
  size?: number;
  /** Which airframe is flying. Defaults to the Scout. */
  variant?: DroneVariant;
}

/** One animation step: a transform at a point in the lap. */
export interface FrameStep {
  /** 0–1 through the lap. */
  offset: number;
  transform: string;
  easing?: string;
}

function randomIn(rng: Rng, bounds: Rect): Pt {
  return {
    x: rng.range(bounds.x, bounds.x + bounds.width),
    y: rng.range(bounds.y, bounds.y + bounds.height),
  };
}

function clampPt(p: Pt, bounds: Rect): Pt {
  return {
    x: Math.min(bounds.x + bounds.width, Math.max(bounds.x, p.x)),
    y: Math.min(bounds.y + bounds.height, Math.max(bounds.y, p.y)),
  };
}

/** Angle of `p` about `centre`, in [0, 2π). */
function angleOf(p: Pt, centre: Pt): number {
  const a = Math.atan2(p.y - centre.y, p.x - centre.x);
  return a < 0 ? a + Math.PI * 2 : a;
}

/**
 * Orders points so the circuit runs around their centroid.
 *
 * Without this, eight independently sampled points are traversed in sampling
 * order and the drone crosses its own track several times a lap — which reads
 * as a fly rather than a survey aircraft.
 */
function sortByAngle(points: readonly Pt[]): Pt[] {
  const centre = centroid(points);
  return [...points]
    .map((p) => ({ p, a: angleOf(p, centre) }))
    .sort((l, r) => l.a - r.a)
    .map((entry) => entry.p);
}

/**
 * Picks `count` well-spread points out of a pool, farthest-first.
 *
 * A minimum-distance rejection filter was the obvious alternative, but on a
 * small island — a narrow window crops the map hard — no threshold works for
 * every world: too large and sampling never fills the circuit, too small and
 * the drone circles one field. Farthest-first always returns a full set and is
 * as spread as the available ground allows.
 */
function farthestFirst(pool: readonly Pt[], count: number): Pt[] {
  const chosen: Pt[] = [pool[0]];
  while (chosen.length < count) {
    let best = pool[0];
    let bestGap = -1;
    for (const candidate of pool) {
      let gap = Infinity;
      for (const taken of chosen) gap = Math.min(gap, dist(candidate, taken));
      if (gap > bestGap) {
        bestGap = gap;
        best = candidate;
      }
    }
    chosen.push(best);
  }
  return chosen;
}

/** Last-resort circuit: a ring of stops inside the bounds. */
function ringRoute(bounds: Rect): Pt[] {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const rx = bounds.width / 2;
  const ry = bounds.height / 2;
  return Array.from({ length: PATROL_STOPS }, (_, i) => {
    const a = (i / PATROL_STOPS) * Math.PI * 2;
    return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
  });
}

/** No devices found: sweep open ground. */
function surveyRoute(rng: Rng, bounds: Rect, allow?: (p: Pt) => boolean): Pt[] {
  const pool: Pt[] = [];
  for (let i = 0; i < SURVEY_SAMPLES; i++) {
    const p = randomIn(rng, bounds);
    if (!allow || allow(p)) pool.push(p);
  }
  if (pool.length < PATROL_STOPS) return ringRoute(bounds);
  return sortByAngle(farthestFirst(pool, PATROL_STOPS));
}

interface Slot {
  angle: number;
  target?: Pt;
}

/**
 * Devices found: a lap that visits dinosaurs.
 *
 * Each visited animal contributes two waypoints — an approach at cruise height
 * and a dip just above it — and every stop gets an equal share of the lap's
 * time. That is what produces the dip: the two-waypoint hop across one animal is
 * short, so the drone crawls through it, while the long legs between animals are
 * covered fast. No separate animation is needed for the behaviour.
 *
 * Fewer than four devices leaves empty slots, filled with transit legs placed in
 * the widest angular gaps, so the lap stays a rough circle rather than a
 * shuttle back and forth over one animal.
 */
function visitRoute(bounds: Rect, targets: readonly Pt[]): Pt[] {
  const centre = centroid(targets);
  const visits = [...targets]
    .map((p) => ({ p, a: angleOf(p, centre) }))
    .sort((l, r) => l.a - r.a)
    .slice(0, MAX_VISITS);

  const slots: Slot[] = visits.map((v) => ({ angle: v.a, target: v.p }));

  // A single visit has no gaps to speak of — its own angle is the only one — so
  // seed the ring with the opposite side before filling.
  if (slots.length === 1) slots.push({ angle: (slots[0].angle + Math.PI) % (Math.PI * 2) });

  while (slots.length < PATROL_SLOTS) {
    slots.sort((l, r) => l.angle - r.angle);
    let at = 0;
    let widest = -1;
    for (let i = 0; i < slots.length; i++) {
      const next = slots[(i + 1) % slots.length];
      const span = i === slots.length - 1
        ? next.angle + Math.PI * 2 - slots[i].angle
        : next.angle - slots[i].angle;
      if (span > widest) {
        widest = span;
        at = i;
      }
    }
    slots.push({ angle: (slots[at].angle + widest / 2) % (Math.PI * 2) });
  }
  slots.sort((l, r) => l.angle - r.angle);

  const orbitR = Math.max(
    MIN_ORBIT_R,
    targets.reduce((max, t) => Math.max(max, dist(t, centre)), 0) + ORBIT_MARGIN,
  );
  const step = (Math.PI * 2) / PATROL_SLOTS;

  const route: Pt[] = [];
  slots.forEach((slot, i) => {
    if (slot.target) {
      // Alternating sides so two visits in a row don't retrace the same arc.
      const side = i % 2 === 0 ? 1 : -1;
      route.push(clampPt({ x: slot.target.x + side * APPROACH_DX, y: slot.target.y - HOVER_H }, bounds));
      route.push(clampPt({ x: slot.target.x - side * DIP_DX, y: slot.target.y - DIP_H }, bounds));
      return;
    }
    for (const [a, r] of [[slot.angle, orbitR], [slot.angle + step * 0.35, orbitR * 0.9]] as const) {
      route.push(clampPt({ x: centre.x + Math.cos(a) * r, y: centre.y + Math.sin(a) * r }, bounds));
    }
  });
  return route;
}

/**
 * Tilt at each stop, from the heading of the leg that leaves it.
 *
 * Proportional to how horizontal that leg is, so a drone crossing the map banks
 * over and one dropping onto an animal stays level.
 */
function banksFor(route: readonly Pt[]): number[] {
  return route.map((p, i) => {
    const next = route[(i + 1) % route.length];
    const dx = next.x - p.x;
    const dy = next.y - p.y;
    const reach = Math.abs(dx) + Math.abs(dy);
    if (reach < 1e-6) return 0;
    return Number(((dx / reach) * MAX_BANK).toFixed(2));
  });
}

/** Lap time from lap length, so speed is steady across tight and wide circuits. */
function durationFor(route: readonly Pt[]): number {
  let length = 0;
  for (let i = 0; i < route.length; i++) length += dist(route[i], route[(i + 1) % route.length]);
  return Number(Math.min(MAX_DURATION, Math.max(MIN_DURATION, length / SPEED)).toFixed(2));
}

/** One drone and the circuit it flies. */
export function dronePatrol(opts: DroneOptions = {}): Drone {
  const {
    bounds = DEFAULT_BOUNDS,
    seed = 0,
    allow,
    targets = [],
    size = DRONE_SIZE,
    variant = DEFAULT_VARIANT,
  } = opts;

  const rng = makeRng(seed);
  const route = targets.length > 0
    ? visitRoute(bounds, targets)
    : surveyRoute(rng, bounds, allow);

  const origin = route[0];
  return {
    origin,
    deltas: route.map((p) => ({ x: p.x - origin.x, y: p.y - origin.y })),
    banks: banksFor(route),
    size,
    duration: durationFor(route),
    visiting: targets.length > 0,
    variant,
  };
}

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}

export interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface RoundRect {
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
}

/** One arm, drawn along +x from the airframe centre and rotated to its rotor. */
export interface DroneArm {
  rect: RoundRect;
  /** Degrees, clockwise, about the shape's `origin`. */
  angle: number;
}

/** One rotor assembly and the status light hanging under it. */
export interface DroneRotor {
  /** Motor pod under the blades. */
  pod: Circle;
  /** The wash a spinning rotor reads as. */
  disc: Circle;
  /** One two-ended blade; the renderer draws it once per `bladeAngles` entry. */
  blade: Ellipse;
  cap: Circle;
  light: Circle;
  glow: Circle;
}

export interface DroneShape {
  /** The airframe's centre: the pivot every arm rotation is about. */
  origin: Pt;
  /** Ground shadow, well below the aircraft — this is what makes it airborne. */
  shadow: Ellipse;
  /** Four arms out to the rotors. */
  arms: DroneArm[];
  body: RoundRect;
  canopy: Ellipse;
  /** Downward camera: the reason a survey drone is out here at all. */
  camera: Circle;
  skids: RoundRect[];
  /** One per `rotorMounts` entry: four for a quad, six for a hexa. */
  rotors: DroneRotor[];
  /** Blade angles within each fan, in degrees. */
  blades: number[];
}

/**
 * The drone as drawable primitives, in the same coordinate space as the route.
 *
 * Lives here rather than in the component for the reason `dinoShape` does: the
 * numbers are the part that can be wrong, and a test can only check them if they
 * are data. In particular it is what lets a test prove the drawing fits inside
 * the `DRONE_EXTENT` the placement bounds are derived from — the two are easy to
 * drift apart, and the symptom is a clipped rotor at the edge of the panel.
 *
 * A quadcopter, drawn from above — unlike the dinosaurs, which are in profile. A
 * rotor only reads as spinning if you are looking down the shaft, and four discs
 * in an X is the silhouette everyone recognises as a drone.
 */
export function droneShape(drone: Drone): DroneShape {
  const s = drone.size;
  const { x, y } = drone.origin;
  const v = drone.variant ?? DEFAULT_VARIANT;
  const mounts = rotorMounts(v);

  return {
    origin: { x, y },
    shadow: { cx: x, cy: y + s * SHADOW_DROP, rx: s * (v.bodyW + 0.26), ry: s * SHADOW_RY },
    arms: mounts.map((mount) => {
      const reach = Math.hypot(mount.x, mount.y) * s;
      return {
        // Drawn along +x from just behind the centre, then turned to its rotor —
        // one rect and an angle rather than four hand-placed diagonals.
        rect: {
          x: x - s * 0.06,
          y: y - s * 0.055,
          width: reach + s * 0.06,
          height: s * 0.11,
          rx: s * 0.055,
        },
        angle: Number(((Math.atan2(mount.y, mount.x) * 180) / Math.PI).toFixed(2)),
      };
    }),
    body: {
      x: x - s * v.bodyW,
      y: y - s * v.bodyH,
      width: s * v.bodyW * 2,
      height: s * v.bodyH * 2,
      rx: s * Math.min(v.bodyW, v.bodyH) * 0.65,
    },
    // Forward of centre, so the airframe has a nose from above.
    canopy: { cx: x, cy: y - s * v.bodyH * 0.38, rx: s * v.bodyW * 0.55, ry: s * v.bodyH * 0.42 },
    // Gimbal, slung under the tail end.
    camera: { cx: x, cy: y + s * v.bodyH * 0.47, r: s * v.bodyH * 0.32 },
    // Landing legs, fore and aft, reading as being underneath the body.
    skids: [-1, 1].map((side) => ({
      x: x - s * v.bodyW * 1.05,
      y: y + side * s * (v.bodyH + 0.06) - s * 0.03,
      width: s * v.bodyW * 2.1,
      height: s * 0.06,
      rx: s * 0.03,
    })),
    rotors: mounts.map((mount) => {
      const cx = x + mount.x * s;
      const cy = y + mount.y * s;
      return {
        pod: { cx, cy, r: s * v.discR * 0.33 },
        disc: { cx, cy, r: s * v.discR },
        blade: { cx, cy, rx: s * (v.discR - 0.02), ry: s * v.discR * 0.12 },
        cap: { cx, cy, r: s * v.discR * 0.17 },
        // Under the pod, clear of the disc, so the lights ring the aircraft.
        light: { cx, cy: cy + s * v.discR * 0.58, r: s * 0.09 },
        glow: { cx, cy: cy + s * v.discR * 0.58, r: s * 0.18 },
      };
    }),
    blades: bladeAngles(v),
  };
}

/** One piece of a drone that didn't come home. */
export interface BurstShard {
  /** Where it ends up, relative to the drone's centre. */
  dx: number;
  dy: number;
  r: number;
  /** Seconds into the burst before it starts moving. */
  delay: number;
  /** Hot pieces are drawn in the burst colour, the rest in the airframe's. */
  hot: boolean;
}

/** How many pieces a drone comes apart into. */
export const BURST_SHARDS = 11;

/**
 * The debris of a burst, seeded from the drone's own route.
 *
 * Seeded rather than random so the same failed sweep always breaks up the same
 * way — which is what makes it a drawing rather than a particle system, and keeps
 * it testable. A ring of shards thrown outward at uneven angles and speeds: even
 * spacing reads as a flower, not an explosion.
 */
export function burstShards(drone: Drone): BurstShard[] {
  const rng = makeRng(hashText(`burst:${drone.duration}:${drone.origin.x}:${drone.origin.y}`));
  const s = drone.size;
  return Array.from({ length: BURST_SHARDS }, (_, i) => {
    const angle = ((i + rng.range(0.15, 0.85)) / BURST_SHARDS) * Math.PI * 2;
    const throwR = s * rng.range(1.1, 2.4);
    return {
      dx: Math.cos(angle) * throwR,
      dy: Math.sin(angle) * throwR,
      r: s * rng.range(0.05, 0.13),
      delay: rng.range(0, 0.09),
      hot: rng.chance(0.35),
    };
  });
}

/**
 * The circuit as animation steps.
 *
 * Built here rather than in CSS because the waypoint count and values are data:
 * a static `@keyframes` rule would have to read them through custom properties,
 * which pins the stop count for good and puts the route somewhere untestable.
 * These feed element.animate() directly.
 *
 * `easing` sits on each step, where it governs the leg *starting* there, so the
 * drone eases out of every waypoint instead of gliding through the whole lap at
 * one rate.
 */
export function patrolFrames(drone: Drone): FrameStep[] {
  const steps: FrameStep[] = drone.deltas.map((d, i) => ({
    offset: i / drone.deltas.length,
    transform: `translate(${d.x.toFixed(2)}px, ${d.y.toFixed(2)}px)`,
    easing: 'ease-in-out',
  }));
  // Closes the loop: the last leg returns to where the first began.
  steps.push({ offset: 1, transform: steps[0].transform });
  return steps;
}

/** The matching tilt track, run on its own layer so it doesn't fight the travel. */
export function bankFrames(drone: Drone): FrameStep[] {
  const steps: FrameStep[] = drone.banks.map((deg, i) => ({
    offset: i / drone.banks.length,
    transform: `rotate(${deg}deg)`,
    easing: 'ease-in-out',
  }));
  steps.push({ offset: 1, transform: steps[0].transform });
  return steps;
}

// --- what the drone says ---------------------------------------------------

/**
 * The drone's report, or null when it has nothing worth saying.
 *
 * Null rather than a "still looking" string on purpose: the toolbar chip
 * already narrates the search, complete with a countdown, and a bubble
 * repeating it would be noise attached to a moving object. The bubble is for
 * the one moment the chip cannot dramatise — the find.
 *
 * Kept a pure function of the count so the wording is swappable. A generated
 * or AI-written line can be dropped in here, or passed to `chatterBubble`
 * directly, without any of the geometry below needing to know.
 */
export function droneMessage(found: number): string | null {
  if (!Number.isFinite(found) || found <= 0) return null;
  return `Found ${found} rare dinosaur${found === 1 ? '' : 's'}`;
}

/** Type size of the bubble's text, in world units. Matches .land-drone-chat. */
export const CHAT_FONT = 12;

/**
 * Advance width of one character at CHAT_FONT.
 *
 * The bubble is sized from the string rather than measured, because it is drawn
 * inside an SVG viewBox that is scaled to the panel — getComputedTextLength
 * would need a live, laid-out element and would put the geometry somewhere no
 * test can reach. 0.6em is the advance of the monospace face the label styles
 * already use, so the estimate is exact for it rather than approximate.
 */
export const CHAT_CHAR_W = CHAT_FONT * 0.6;

const CHAT_PAD_X = 9;
const CHAT_PAD_Y = 6;
/** Gap between the airframe and the bubble's near corner. */
const CHAT_GAP = 6;

export interface ChatBubble {
  /** Box, in the same space as `Drone.origin` — i.e. it travels with the drone. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner radius. */
  r: number;
  /** Tail from the bubble back to the airframe, as a path `d`. */
  tail: string;
  /** Where the text baseline anchor sits, left-aligned inside the box. */
  textX: number;
  textY: number;
}

/**
 * A speech bubble sized to `text`, placed up and to the right of the drone.
 *
 * Up and to the right because the drone's own reach is widest across its rotor
 * discs and the ground shadow sits below it, so above the airframe is the only
 * side where a box cannot overlap the thing it belongs to. The caller is
 * responsible for the bubble staying inside the panel: like the airframe, it is
 * drawn relative to `origin` and travels with it.
 */
export function chatterBubble(text: string, size = DRONE_SIZE): ChatBubble {
  const w = Math.max(1, text.length) * CHAT_CHAR_W + CHAT_PAD_X * 2;
  const h = CHAT_FONT + CHAT_PAD_Y * 2;

  // Clear of the rotor disc on the near side, then up by the box's own height.
  const x = size * 0.75 + CHAT_GAP;
  const y = -(size * 1.15) - h;

  // A stubby triangle off the bottom-left corner, aimed back at the airframe.
  const tipX = size * 0.3;
  const tipY = -(size * 0.7);
  const baseX = x + CHAT_PAD_X;
  const tail = [
    `M ${baseX.toFixed(2)} ${(y + h).toFixed(2)}`,
    `L ${(baseX + CHAT_CHAR_W * 1.6).toFixed(2)} ${(y + h).toFixed(2)}`,
    `L ${tipX.toFixed(2)} ${tipY.toFixed(2)}`,
    'Z',
  ].join(' ');

  return {
    x,
    y,
    w,
    h,
    r: 6,
    tail,
    textX: x + CHAT_PAD_X,
    // Baseline rather than centre: dominant-baseline is inconsistent across
    // engines, and this only has to agree with itself.
    textY: y + CHAT_PAD_Y + CHAT_FONT * 0.8,
  };
}
