import { describe, it, expect } from 'vitest';
import {
  bankFrames,
  DEFAULT_BOUNDS,
  DRONE_EXTENT,
  DRONE_SIZE,
  dronePatrol,
  droneInsets,
  droneShape,
  MAX_BANK,
  MAX_VISITS,
  patrolFrames,
  PATROL_STOPS,
  type Drone,
  type DroneShape,
} from './drone';
import { insetRect, type Rect } from './viewbox';
import type { Pt } from './landscape/geometry';

// A spread of seeds, so a property that only holds for one lucky circuit fails.
const SEEDS = [1, 7, 42, 1234, 20260806, 999999, 0];

const BOUNDS: Rect = insetRect(DEFAULT_BOUNDS, droneInsets());

/** Absolute waypoints, which is what every geometric assertion is about. */
function waypoints(drone: Drone): Pt[] {
  return drone.deltas.map((d) => ({ x: drone.origin.x + d.x, y: drone.origin.y + d.y }));
}

function inside(p: Pt, bounds: Rect): boolean {
  return (
    p.x >= bounds.x - 1e-6 &&
    p.x <= bounds.x + bounds.width + 1e-6 &&
    p.y >= bounds.y - 1e-6 &&
    p.y <= bounds.y + bounds.height + 1e-6
  );
}

/** Somewhere for a dinosaur to stand, spread around the map. */
const HERD: Pt[] = [
  { x: 500, y: 400 },
  { x: 900, y: 620 },
  { x: 1100, y: 330 },
  { x: 700, y: 700 },
  { x: 1250, y: 560 },
  { x: 420, y: 640 },
];

describe('droneInsets', () => {
  it('scales with the drone and covers its whole reach', () => {
    const insets = droneInsets(40);
    expect(insets.left).toBeCloseTo(DRONE_EXTENT.left * 40);
    expect(insets.bottom).toBeCloseTo(DRONE_EXTENT.bottom * 40);
  });

  it('defaults to the standard size', () => {
    expect(droneInsets()).toEqual(droneInsets(DRONE_SIZE));
  });

  it('leaves room below for the ground shadow, which is the furthest part', () => {
    // The shadow is drawn well under the aircraft, so the bottom inset has to be
    // the largest — getting this wrong clips the shadow at the panel edge.
    const insets = droneInsets();
    expect(insets.bottom).toBeGreaterThan(insets.top);
    expect(insets.bottom).toBeGreaterThan(insets.left);
  });
});

describe('droneShape / DRONE_EXTENT', () => {
  /** Every drawn primitive's bounding box, which is all the extent is about. */
  function boxes(shape: DroneShape): Rect[] {
    const out: Rect[] = [];
    const circle = (c: { cx: number; cy: number; r: number }) =>
      out.push({ x: c.cx - c.r, y: c.cy - c.r, width: c.r * 2, height: c.r * 2 });
    const ellipse = (e: { cx: number; cy: number; rx: number; ry: number }) =>
      out.push({ x: e.cx - e.rx, y: e.cy - e.ry, width: e.rx * 2, height: e.ry * 2 });

    ellipse(shape.shadow);
    out.push(shape.body, ...shape.skids);
    ellipse(shape.canopy);

    // An arm is drawn along +x and turned to its rotor, so its reach is the box
    // around its four rotated corners, not the box it was authored in.
    for (const arm of shape.arms) {
      const rad = (arm.angle * Math.PI) / 180;
      const corners = [
        { x: arm.rect.x, y: arm.rect.y },
        { x: arm.rect.x + arm.rect.width, y: arm.rect.y },
        { x: arm.rect.x, y: arm.rect.y + arm.rect.height },
        { x: arm.rect.x + arm.rect.width, y: arm.rect.y + arm.rect.height },
      ].map((c) => {
        const dx = c.x - shape.origin.x;
        const dy = c.y - shape.origin.y;
        return {
          x: shape.origin.x + dx * Math.cos(rad) - dy * Math.sin(rad),
          y: shape.origin.y + dx * Math.sin(rad) + dy * Math.cos(rad),
        };
      });
      const xs = corners.map((c) => c.x);
      const ys = corners.map((c) => c.y);
      out.push({
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      });
    }
    circle(shape.camera);
    for (const rotor of shape.rotors) {
      circle(rotor.pod);
      circle(rotor.disc);
      circle(rotor.cap);
      circle(rotor.light);
      circle(rotor.glow);
      // A blade is drawn twice, the second turned 90° about the pod, so its reach
      // counts in both axes.
      const { cx, cy, rx } = rotor.blade;
      circle({ cx, cy, r: rx });
    }
    return out;
  }

  it('is finite everywhere, for any size', () => {
    for (const size of [12, 34, 90]) {
      const drone = dronePatrol({ bounds: BOUNDS, seed: 3, size });
      for (const box of boxes(droneShape(drone))) {
        for (const n of [box.x, box.y, box.width, box.height]) expect(Number.isFinite(n)).toBe(true);
      }
    }
  });

  it('actually fits inside DRONE_EXTENT — the point of the constant', () => {
    // The placement bounds are inset by DRONE_EXTENT, so anything drawn beyond it
    // is clipped by the panel edge exactly when the drone flies out there. The
    // rotors reach further sideways than the airframe does, which is the trap.
    for (const size of [12, 34, 90]) {
      const drone = dronePatrol({ bounds: BOUNDS, seed: 3, size });
      const { x, y } = drone.origin;
      for (const box of boxes(droneShape(drone))) {
        expect(x - box.x).toBeLessThanOrEqual(DRONE_EXTENT.left * size);
        expect(box.x + box.width - x).toBeLessThanOrEqual(DRONE_EXTENT.right * size);
        expect(y - box.y).toBeLessThanOrEqual(DRONE_EXTENT.top * size);
        expect(box.y + box.height - y).toBeLessThanOrEqual(DRONE_EXTENT.bottom * size);
      }
    }
  });

  it('still fits once the tilt has rolled it over', () => {
    // The airframe rolls up to MAX_BANK about its own centre, which throws a
    // corner rotor beyond where the level drawing reaches — the tilt is the part
    // of the extent that is easiest to forget.
    const size = 34;
    const drone = dronePatrol({ bounds: BOUNDS, seed: 3, size });
    const shape = droneShape(drone);
    const rad = (MAX_BANK * Math.PI) / 180;

    for (const sign of [1, -1]) {
      for (const rotor of shape.rotors) {
        const dx = rotor.disc.cx - shape.origin.x;
        const dy = rotor.disc.cy - shape.origin.y;
        const rx = dx * Math.cos(sign * rad) - dy * Math.sin(sign * rad);
        const ry = dx * Math.sin(sign * rad) + dy * Math.cos(sign * rad);
        expect(Math.abs(rx) + rotor.disc.r).toBeLessThanOrEqual(DRONE_EXTENT.left * size);
        expect(-ry + rotor.disc.r).toBeLessThanOrEqual(DRONE_EXTENT.top * size);
        expect(ry + rotor.disc.r).toBeLessThanOrEqual(DRONE_EXTENT.bottom * size);
      }
    }
  });

  it('is a quadcopter: four rotors, each on its own arm', () => {
    const shape = droneShape(dronePatrol({ bounds: BOUNDS, seed: 3 }));
    expect(shape.rotors).toHaveLength(4);
    expect(shape.arms).toHaveLength(4);

    // One rotor per quadrant, or it isn't an X.
    const quadrants = new Set(
      shape.rotors.map(
        (r) => `${Math.sign(r.pod.cx - shape.origin.x)},${Math.sign(r.pod.cy - shape.origin.y)}`,
      ),
    );
    expect(quadrants.size).toBe(4);
  });

  it('points each arm at its own rotor', () => {
    const shape = droneShape(dronePatrol({ bounds: BOUNDS, seed: 3 }));
    shape.arms.forEach((arm, i) => {
      const rotor = shape.rotors[i];
      const expected = Math.atan2(rotor.pod.cy - shape.origin.y, rotor.pod.cx - shape.origin.x);
      expect(arm.angle).toBeCloseTo((expected * 180) / Math.PI, 1);
      // Long enough to reach the pod it is holding up.
      const reach = Math.hypot(rotor.pod.cx - shape.origin.x, rotor.pod.cy - shape.origin.y);
      expect(arm.rect.width).toBeGreaterThanOrEqual(reach);
    });
  });

  it('hangs its shadow below the aircraft, not on it', () => {
    const drone = dronePatrol({ bounds: BOUNDS, seed: 3 });
    const shape = droneShape(drone);
    const lowestPart = Math.max(...shape.skids.map((s) => s.y + s.height));
    expect(shape.shadow.cy).toBeGreaterThan(lowestPart + drone.size);
  });

  it('spins its blades about the motor, or the rotor wobbles', () => {
    for (const rotor of droneShape(dronePatrol({ bounds: BOUNDS, seed: 3 })).rotors) {
      // The spin is a CSS rotation about the group's own bounding-box centre, so
      // every piece of a rotor has to be concentric with the pod.
      expect(rotor.blade.cx).toBeCloseTo(rotor.pod.cx);
      expect(rotor.blade.cy).toBeCloseTo(rotor.pod.cy);
      expect(rotor.disc.cx).toBeCloseTo(rotor.pod.cx);
      expect(rotor.cap.cy).toBeCloseTo(rotor.pod.cy);
    }
  });

  it('puts a light under each rotor', () => {
    const shape = droneShape(dronePatrol({ bounds: BOUNDS, seed: 3 }));
    for (const rotor of shape.rotors) {
      expect(rotor.light.cy).toBeGreaterThan(rotor.pod.cy);
      expect(rotor.glow.r).toBeGreaterThan(rotor.light.r);
    }
  });
});

describe('dronePatrol shape', () => {
  for (const seed of SEEDS) {
    describe(`seed ${seed}`, () => {
      const searching = dronePatrol({ bounds: BOUNDS, seed });
      const visiting = dronePatrol({ bounds: BOUNDS, seed, targets: HERD.slice(0, 3) });

      it('is deterministic', () => {
        expect(dronePatrol({ bounds: BOUNDS, seed })).toEqual(searching);
      });

      it('flies exactly PATROL_STOPS waypoints, searching or visiting', () => {
        expect(searching.deltas).toHaveLength(PATROL_STOPS);
        expect(searching.banks).toHaveLength(PATROL_STOPS);
        expect(visiting.deltas).toHaveLength(PATROL_STOPS);
        expect(visiting.banks).toHaveLength(PATROL_STOPS);
      });

      it('parks at the first waypoint, so a still drone is on the map', () => {
        expect(searching.deltas[0]).toEqual({ x: 0, y: 0 });
        expect(inside(searching.origin, BOUNDS)).toBe(true);
        expect(inside(visiting.origin, BOUNDS)).toBe(true);
      });

      it('stays inside its bounds for the whole lap', () => {
        for (const p of waypoints(searching)) expect(inside(p, BOUNDS)).toBe(true);
        for (const p of waypoints(visiting)) expect(inside(p, BOUNDS)).toBe(true);
      });

      it('banks no harder than MAX_BANK', () => {
        for (const bank of [...searching.banks, ...visiting.banks]) {
          expect(Math.abs(bank)).toBeLessThanOrEqual(MAX_BANK);
        }
      });

      it('takes a sane time per lap', () => {
        expect(searching.duration).toBeGreaterThanOrEqual(16);
        expect(searching.duration).toBeLessThanOrEqual(64);
      });

      it('reports which kind of circuit it planned', () => {
        expect(searching.visiting).toBe(false);
        expect(visiting.visiting).toBe(true);
      });
    });
  }

  it('does not touch Math.random', () => {
    const real = Math.random;
    Math.random = () => {
      throw new Error('dronePatrol must be seeded');
    };
    try {
      expect(() => dronePatrol({ bounds: BOUNDS, seed: 5 })).not.toThrow();
    } finally {
      Math.random = real;
    }
  });

  it('gives different seeds different sweeps', () => {
    const a = dronePatrol({ bounds: BOUNDS, seed: 1 });
    const b = dronePatrol({ bounds: BOUNDS, seed: 2 });
    expect(a.deltas).not.toEqual(b.deltas);
  });
});

describe('survey sweep', () => {
  it('keeps every waypoint where the caller allows', () => {
    // Stand in for "on land": the left half of the map only.
    const allow = (p: Pt) => p.x < 800;
    for (const seed of SEEDS) {
      const drone = dronePatrol({ bounds: BOUNDS, seed, allow });
      for (const p of waypoints(drone)) expect(allow(p)).toBe(true);
    }
  });

  it('still flies a full circuit when nothing is allowed', () => {
    // The drone is the scanning indicator: a world with no acceptable ground
    // must not leave the map empty, which is why this falls back rather than
    // returning null the way randomDino does.
    const drone = dronePatrol({ bounds: BOUNDS, seed: 3, allow: () => false });
    expect(drone.deltas).toHaveLength(PATROL_STOPS);
    for (const p of waypoints(drone)) expect(inside(p, BOUNDS)).toBe(true);
  });

  it('spreads out rather than circling one field', () => {
    for (const seed of SEEDS) {
      const points = waypoints(dronePatrol({ bounds: BOUNDS, seed }));
      let span = 0;
      for (const a of points) {
        for (const b of points) span = Math.max(span, Math.hypot(a.x - b.x, a.y - b.y));
      }
      // Comfortably more than a third of the map's diagonal.
      expect(span).toBeGreaterThan(500);
    }
  });

  it('survives bounds collapsed to a point', () => {
    const pin: Rect = { x: 400, y: 400, width: 0, height: 0 };
    const drone = dronePatrol({ bounds: pin, seed: 9 });
    expect(drone.deltas).toHaveLength(PATROL_STOPS);
    for (const p of waypoints(drone)) {
      expect(p.x).toBeCloseTo(400);
      expect(p.y).toBeCloseTo(400);
    }
    expect(drone.duration).toBeGreaterThan(0);
  });
});

describe('visiting a herd', () => {
  it('dips toward every animal it visits', () => {
    for (const seed of SEEDS) {
      for (const count of [1, 2, 3, 4]) {
        const targets = HERD.slice(0, count);
        const drone = dronePatrol({ bounds: BOUNDS, seed, targets });
        const points = waypoints(drone);

        for (const t of targets) {
          const near = points.filter((p) => Math.abs(p.x - t.x) < 140 && p.y < t.y && t.y - p.y < 160);
          // An approach at cruise height and a lower dip: the pair is what makes
          // the drone loiter over the animal, since every leg gets equal time.
          expect(near.length).toBeGreaterThanOrEqual(2);
          const heights = near.map((p) => t.y - p.y).sort((a, b) => a - b);
          expect(heights[heights.length - 1] - heights[0]).toBeGreaterThan(20);
        }
      }
    }
  });

  it('visits at most MAX_VISITS per lap and still flies PATROL_STOPS', () => {
    const drone = dronePatrol({ bounds: BOUNDS, seed: 11, targets: HERD });
    expect(HERD.length).toBeGreaterThan(MAX_VISITS);
    expect(drone.deltas).toHaveLength(PATROL_STOPS);

    const points = waypoints(drone);
    const visited = HERD.filter((t) =>
      points.some((p) => Math.abs(p.x - t.x) < 140 && p.y < t.y && t.y - p.y < 160),
    );
    expect(visited.length).toBeLessThanOrEqual(MAX_VISITS);
    expect(visited.length).toBeGreaterThan(0);
  });

  it('re-plans when the herd changes', () => {
    const one = dronePatrol({ bounds: BOUNDS, seed: 4, targets: HERD.slice(0, 2) });
    const two = dronePatrol({ bounds: BOUNDS, seed: 4, targets: HERD.slice(0, 3) });
    expect(one.deltas).not.toEqual(two.deltas);
  });

  it('ignores the seed once there are animals to visit', () => {
    // The route follows the herd, not the world: two seeds with the same herd
    // must fly the same circuit, or every regenerate would move the drone for
    // no reason the user can see.
    const a = dronePatrol({ bounds: BOUNDS, seed: 1, targets: HERD.slice(0, 3) });
    const b = dronePatrol({ bounds: BOUNDS, seed: 987654, targets: HERD.slice(0, 3) });
    expect(a).toEqual(b);
  });

  it('stays inside the bounds even for a herd at the very edge', () => {
    const corner: Pt[] = [
      { x: BOUNDS.x, y: BOUNDS.y },
      { x: BOUNDS.x + BOUNDS.width, y: BOUNDS.y + BOUNDS.height },
    ];
    const drone = dronePatrol({ bounds: BOUNDS, seed: 6, targets: corner });
    for (const p of waypoints(drone)) expect(inside(p, BOUNDS)).toBe(true);
  });
});

describe('lap timing', () => {
  it('takes longer over a wider circuit', () => {
    const tight = dronePatrol({
      bounds: BOUNDS,
      seed: 8,
      targets: [{ x: 780, y: 440 }, { x: 820, y: 470 }],
    });
    const wide = dronePatrol({
      bounds: BOUNDS,
      seed: 8,
      targets: [{ x: 260, y: 260 }, { x: 1340, y: 640 }],
    });
    expect(wide.duration).toBeGreaterThan(tight.duration);
  });
});

describe('animation steps', () => {
  const drone = dronePatrol({ bounds: BOUNDS, seed: 42, targets: HERD.slice(0, 3) });

  it('closes the loop, so a lap has no jump back to the start', () => {
    const frames = patrolFrames(drone);
    expect(frames).toHaveLength(PATROL_STOPS + 1);
    expect(frames[0].offset).toBe(0);
    expect(frames[frames.length - 1].offset).toBe(1);
    expect(frames[frames.length - 1].transform).toBe(frames[0].transform);
  });

  it('spaces the waypoints evenly through the lap', () => {
    const offsets = patrolFrames(drone).map((f) => f.offset);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    expect(offsets[1]).toBeCloseTo(1 / PATROL_STOPS);
  });

  it('starts from no offset, so the drawn position is the first waypoint', () => {
    expect(patrolFrames(drone)[0].transform).toBe('translate(0.00px, 0.00px)');
  });

  it('eases out of each waypoint rather than gliding the whole lap', () => {
    // Per-step easing is what makes it settle at an animal; a single easing on
    // the animation options would apply once across the entire circuit.
    for (const frame of patrolFrames(drone).slice(0, -1)) expect(frame.easing).toBe('ease-in-out');
  });

  it('emits a matching tilt track', () => {
    const banks = bankFrames(drone);
    expect(banks).toHaveLength(PATROL_STOPS + 1);
    expect(banks[banks.length - 1].transform).toBe(banks[0].transform);
    for (const frame of banks) expect(frame.transform).toMatch(/^rotate\(-?\d+(\.\d+)?deg\)$/);
  });
});
