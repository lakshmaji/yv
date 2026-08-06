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

import { makeRng, type Rng } from './landscape/rng';
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
 * Rotor hub offsets from the airframe's centre, in units of `size`.
 *
 * A quadcopter, so four of them in an X — front pair slightly wider than the rear
 * so the aircraft has a nose from above, which is what lets the tilt read as
 * banking into a turn rather than as the whole drawing wobbling.
 */
export const ROTOR_MOUNTS = [
  { x: -0.86, y: -0.62 },
  { x: 0.86, y: -0.62 },
  { x: -0.8, y: 0.66 },
  { x: 0.8, y: 0.66 },
] as const;

/** Rotor disc radius, in units of `size`. */
const ROTOR_R = 0.42;

/**
 * How far the drone reaches from its centre, in units of `size`.
 *
 * Set by the rotor discs, not the airframe: a hub sits ~1.07 out along the
 * diagonal and its disc spans 0.42 more, and the tilt swings that corner further
 * still. Down is by far the largest, because the ground shadow is drawn well
 * below the aircraft — clipping that at the panel edge is what gives away that
 * the drone is a drawing rather than something flying over the island.
 */
export const DRONE_EXTENT = { left: 1.45, right: 1.45, top: 1.3, bottom: 2.6 } as const;

/**
 * Bounds insets that keep the whole drone — including the ground shadow it
 * drags along under itself — inside a rect.
 */
export function droneInsets(size = DRONE_SIZE): Required<Insets> {
  return {
    left: DRONE_EXTENT.left * size,
    right: DRONE_EXTENT.right * size,
    top: DRONE_EXTENT.top * size,
    bottom: DRONE_EXTENT.bottom * size,
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
  /** One blade; the renderer draws a second at 90° about the pod. */
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
  /** Four rotors, in `ROTOR_MOUNTS` order. */
  rotors: DroneRotor[];
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

  return {
    origin: { x, y },
    shadow: { cx: x, cy: y + s * 2.3, rx: s * 0.66, ry: s * 0.17 },
    arms: ROTOR_MOUNTS.map((mount) => {
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
      x: x - s * 0.4,
      y: y - s * 0.34,
      width: s * 0.8,
      height: s * 0.68,
      rx: s * 0.22,
    },
    // Forward of centre, so the airframe has a nose from above.
    canopy: { cx: x, cy: y - s * 0.13, rx: s * 0.22, ry: s * 0.14 },
    // Gimbal, slung under the tail end.
    camera: { cx: x, cy: y + s * 0.16, r: s * 0.11 },
    // Landing legs, fore and aft, reading as being underneath the body.
    skids: [-1, 1].map((side) => ({
      x: x - s * 0.42,
      y: y + side * s * 0.4 - s * 0.03,
      width: s * 0.84,
      height: s * 0.06,
      rx: s * 0.03,
    })),
    rotors: ROTOR_MOUNTS.map((mount) => {
      const cx = x + mount.x * s;
      const cy = y + mount.y * s;
      return {
        pod: { cx, cy, r: s * 0.14 },
        disc: { cx, cy, r: s * ROTOR_R },
        blade: { cx, cy, rx: s * (ROTOR_R - 0.02), ry: s * 0.05 },
        cap: { cx, cy, r: s * 0.07 },
        // Under the pod, clear of the disc, so four lights ring the aircraft.
        light: { cx, cy: cy + s * 0.24, r: s * 0.09 },
        glow: { cx, cy: cy + s * 0.24, r: s * 0.18 },
      };
    }),
  };
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
