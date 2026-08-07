import { describe, it, expect } from 'vitest';
import {
  bankFrames,
  bladeAngles,
  chatterBubble,
  CHAT_CHAR_W,
  droneMessage,
  BURST_SHARDS,
  burstShards,
  DEFAULT_BOUNDS,
  DEFAULT_VARIANT,
  DRONE_SIZE,
  DRONE_VARIANTS,
  dronePatrol,
  droneExtent,
  droneInsets,
  droneShape,
  MAX_BANK,
  MAX_VISITS,
  patrolFrames,
  PATROL_STOPS,
  rotorMounts,
  variantById,
  type Drone,
  type DroneShape,
  type DroneVariant,
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

describe('the fleet', () => {
  it('has unique ids and a default that is one of them', () => {
    const ids = DRONE_VARIANTS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DRONE_VARIANTS).toContain(DEFAULT_VARIANT);
  });

  it('is worth choosing between: shapes and colours actually differ', () => {
    // The whole point of "send another drone" is that it is a different machine,
    // not a reroll of the same drawing.
    const shapes = DRONE_VARIANTS.map((v) => `${v.rotors}x${v.blades}`);
    expect(new Set(shapes).size).toBe(shapes.length);
    const shells = DRONE_VARIANTS.map((v) => v.shell);
    expect(new Set(shells).size).toBe(shells.length);
    expect(new Set(DRONE_VARIANTS.map((v) => v.rotors))).toEqual(new Set([4, 6]));
  });

  it('describes every airframe for the picker', () => {
    for (const v of DRONE_VARIANTS) {
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.blurb.length).toBeGreaterThan(0);
      expect(v.shell).toMatch(/^#[0-9a-f]{6}$/i);
      expect(v.shellDark).toMatch(/^#[0-9a-f]{6}$/i);
      expect(v.blade).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('only has even blade counts, since a blade is a two-ended ellipse', () => {
    for (const v of DRONE_VARIANTS) {
      expect(v.blades % 2).toBe(0);
      expect(bladeAngles(v)).toHaveLength(v.blades / 2);
    }
  });

  it('spaces the blades evenly over a half turn', () => {
    // A half turn, not a full one: each ellipse already covers both sides of the
    // hub, so spacing them over 360° would draw every blade twice.
    for (const v of DRONE_VARIANTS) {
      const angles = bladeAngles(v);
      expect(angles[0]).toBe(0);
      for (let i = 1; i < angles.length; i++) {
        expect(angles[i] - angles[i - 1]).toBeCloseTo(180 / angles.length);
      }
      expect(angles[angles.length - 1]).toBeLessThan(180);
    }
  });

  it('mounts one rotor per arm, spread around the airframe', () => {
    for (const v of DRONE_VARIANTS) {
      const mounts = rotorMounts(v);
      expect(mounts).toHaveLength(v.rotors);
      // None on top of another, and all roughly at the variant's reach.
      for (let i = 0; i < mounts.length; i++) {
        for (let j = i + 1; j < mounts.length; j++) {
          expect(Math.hypot(mounts[i].x - mounts[j].x, mounts[i].y - mounts[j].y)).toBeGreaterThan(0.3);
        }
        const r = Math.hypot(mounts[i].x, mounts[i].y);
        expect(r).toBeGreaterThan(v.reach * 0.7);
        expect(r).toBeLessThanOrEqual(v.reach * 1.05);
      }
    }
  });

  it('keeps a hexa clear of dead ahead, so the nose still reads', () => {
    for (const v of DRONE_VARIANTS.filter((x) => x.rotors === 6)) {
      for (const mount of rotorMounts(v)) {
        expect(Math.abs(mount.x)).toBeGreaterThan(0.1);
      }
    }
  });

  it('falls back rather than leaving the map droneless', () => {
    // The id is persisted in settings, so a renamed or dropped variant must not
    // be able to ground the whole fleet.
    expect(variantById('scout').id).toBe('scout');
    expect(variantById('does-not-exist')).toBe(DEFAULT_VARIANT);
    expect(variantById(undefined)).toBe(DEFAULT_VARIANT);
    expect(variantById(null)).toBe(DEFAULT_VARIANT);
    expect(variantById('')).toBe(DEFAULT_VARIANT);
  });
});

describe('droneInsets', () => {
  it('scales with the drone and covers its whole reach', () => {
    const insets = droneInsets(40);
    expect(insets.left).toBeCloseTo(droneExtent().left * 40);
    expect(insets.bottom).toBeCloseTo(droneExtent().bottom * 40);
  });

  it('follows the variant: a wider airframe needs more room', () => {
    const scout = DRONE_VARIANTS.find((v) => v.id === 'scout')!;
    const hauler = DRONE_VARIANTS.find((v) => v.id === 'hauler')!;
    expect(droneInsets(DRONE_SIZE, hauler).left).toBeGreaterThan(droneInsets(DRONE_SIZE, scout).left);
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

describe('droneShape / droneExtent', () => {
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
      // A blade is drawn once per angle around the hub, so its reach counts in
      // both axes.
      const { cx, cy, rx } = rotor.blade;
      circle({ cx, cy, r: rx });
    }
    return out;
  }

  /** One drone of each variant, at a few sizes — the whole matrix. */
  function fleet(): { drone: Drone; variant: DroneVariant; size: number }[] {
    const out: { drone: Drone; variant: DroneVariant; size: number }[] = [];
    for (const variant of DRONE_VARIANTS) {
      for (const size of [12, 34, 90]) {
        out.push({ drone: dronePatrol({ bounds: BOUNDS, seed: 3, size, variant }), variant, size });
      }
    }
    return out;
  }

  it('is finite everywhere, for every variant and size', () => {
    for (const { drone } of fleet()) {
      for (const box of boxes(droneShape(drone))) {
        for (const n of [box.x, box.y, box.width, box.height]) expect(Number.isFinite(n)).toBe(true);
      }
    }
  });

  it('actually fits inside droneExtent — the point of the function', () => {
    // The placement bounds are inset by droneExtent, so anything drawn beyond it
    // is clipped by the panel edge exactly when the drone flies out there. The
    // rotors reach further sideways than the airframe does, which is the trap,
    // and every variant moves its rotors somewhere different.
    for (const { drone, variant, size } of fleet()) {
      const extent = droneExtent(variant);
      const { x, y } = drone.origin;
      for (const box of boxes(droneShape(drone))) {
        expect(x - box.x).toBeLessThanOrEqual(extent.left * size);
        expect(box.x + box.width - x).toBeLessThanOrEqual(extent.right * size);
        expect(y - box.y).toBeLessThanOrEqual(extent.top * size);
        expect(box.y + box.height - y).toBeLessThanOrEqual(extent.bottom * size);
      }
    }
  });

  it('still fits once the tilt has rolled it over', () => {
    // The airframe rolls up to MAX_BANK about its own centre, which throws a
    // corner rotor beyond where the level drawing reaches — the tilt is the part
    // of the extent that is easiest to forget.
    const rad = (MAX_BANK * Math.PI) / 180;
    for (const { drone, variant, size } of fleet()) {
      const extent = droneExtent(variant);
      const shape = droneShape(drone);
      for (const sign of [1, -1]) {
        for (const rotor of shape.rotors) {
          const dx = rotor.disc.cx - shape.origin.x;
          const dy = rotor.disc.cy - shape.origin.y;
          const rx = dx * Math.cos(sign * rad) - dy * Math.sin(sign * rad);
          const ry = dx * Math.sin(sign * rad) + dy * Math.cos(sign * rad);
          expect(Math.abs(rx) + rotor.disc.r).toBeLessThanOrEqual(extent.left * size);
          expect(-ry + rotor.disc.r).toBeLessThanOrEqual(extent.top * size);
          expect(ry + rotor.disc.r).toBeLessThanOrEqual(extent.bottom * size);
        }
      }
    }
  });

  it('draws one rotor per mount and one arm per rotor, for every variant', () => {
    for (const variant of DRONE_VARIANTS) {
      const shape = droneShape(dronePatrol({ bounds: BOUNDS, seed: 3, variant }));
      expect(shape.rotors).toHaveLength(variant.rotors);
      expect(shape.arms).toHaveLength(variant.rotors);
      expect(shape.blades).toEqual(bladeAngles(variant));
    }
  });

  it('lays a quad out as an X: one rotor per quadrant', () => {
    for (const variant of DRONE_VARIANTS.filter((v) => v.rotors === 4)) {
      const shape = droneShape(dronePatrol({ bounds: BOUNDS, seed: 3, variant }));
      const quadrants = new Set(
        shape.rotors.map(
          (r) => `${Math.sign(r.pod.cx - shape.origin.x)},${Math.sign(r.pod.cy - shape.origin.y)}`,
        ),
      );
      expect(quadrants.size).toBe(4);
    }
  });

  it('spreads a hexa so no two rotors overlap', () => {
    for (const variant of DRONE_VARIANTS.filter((v) => v.rotors === 6)) {
      const shape = droneShape(dronePatrol({ bounds: BOUNDS, seed: 3, variant }));
      for (let i = 0; i < shape.rotors.length; i++) {
        for (let j = i + 1; j < shape.rotors.length; j++) {
          const a = shape.rotors[i].pod;
          const b = shape.rotors[j].pod;
          expect(Math.hypot(a.cx - b.cx, a.cy - b.cy)).toBeGreaterThan(a.r * 2);
        }
      }
    }
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

describe('burst debris', () => {
  const drone = dronePatrol({ bounds: BOUNDS, seed: 42 });

  it('is seeded, so the same failed sweep always breaks up the same way', () => {
    expect(burstShards(drone)).toEqual(burstShards(drone));
  });

  it('throws the full count of pieces outward', () => {
    const shards = burstShards(drone);
    expect(shards).toHaveLength(BURST_SHARDS);
    for (const shard of shards) {
      const throwR = Math.hypot(shard.dx, shard.dy);
      expect(throwR).toBeGreaterThan(drone.size);
      expect(shard.r).toBeGreaterThan(0);
      expect(shard.delay).toBeGreaterThanOrEqual(0);
    }
  });

  it('scatters unevenly — even spacing reads as a flower, not an explosion', () => {
    const angles = burstShards(drone)
      .map((s) => Math.atan2(s.dy, s.dx))
      .sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < angles.length; i++) gaps.push(angles[i] - angles[i - 1]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(0.05);
    // But still all the way round, rather than bunched on one side.
    expect(Math.max(...gaps)).toBeLessThan(Math.PI);
  });

  it('goes in every direction', () => {
    const shards = burstShards(drone);
    expect(shards.some((s) => s.dx > 0)).toBe(true);
    expect(shards.some((s) => s.dx < 0)).toBe(true);
    expect(shards.some((s) => s.dy > 0)).toBe(true);
    expect(shards.some((s) => s.dy < 0)).toBe(true);
  });

  it('mixes hot pieces with airframe-coloured ones', () => {
    // Every shard the same colour reads as confetti; the split is what makes it
    // look like something burning apart.
    const shards = DRONE_VARIANTS.flatMap((variant) =>
      burstShards(dronePatrol({ bounds: BOUNDS, seed: 7, variant })),
    );
    expect(shards.some((s) => s.hot)).toBe(true);
    expect(shards.some((s) => !s.hot)).toBe(true);
  });

  it('scales with the airframe', () => {
    const small = burstShards(dronePatrol({ bounds: BOUNDS, seed: 42, size: 10 }));
    const large = burstShards(dronePatrol({ bounds: BOUNDS, seed: 42, size: 100 }));
    const reach = (shards: typeof small) => Math.max(...shards.map((s) => Math.hypot(s.dx, s.dy)));
    expect(reach(large)).toBeGreaterThan(reach(small) * 5);
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

describe('droneMessage', () => {
  const cases: Array<[number, string | null]> = [
    [0, null],
    [-1, null],
    [1, 'Found 1 rare dinosaur'],
    [2, 'Found 2 rare dinosaurs'],
    [12, 'Found 12 rare dinosaurs'],
  ];

  for (const [found, want] of cases) {
    it(`says ${JSON.stringify(want)} for ${found}`, () => {
      expect(droneMessage(found)).toBe(want);
    });
  }

  it('singularises only at exactly one', () => {
    expect(droneMessage(1)).not.toMatch(/dinosaurs/);
    expect(droneMessage(2)).toMatch(/dinosaurs/);
  });

  // The count comes from a list length, but a NaN would render as "Found NaN"
  // and an Infinity as "Found Infinity rare dinosaurs" — both worse than silence.
  it('says nothing rather than nonsense for a non-finite count', () => {
    expect(droneMessage(NaN)).toBeNull();
    expect(droneMessage(Infinity)).toBeNull();
    expect(droneMessage(-Infinity)).toBeNull();
  });
});

describe('chatterBubble', () => {
  it('grows with the text, so a longer line is not clipped', () => {
    const short = chatterBubble('Found 1 rare dinosaur');
    const long = chatterBubble('Found 100 extremely rare and unusual dinosaurs');
    expect(long.w).toBeGreaterThan(short.w);
    // Same type size, so the box height is the one thing that must not move.
    expect(long.h).toBe(short.h);
  });

  it('leaves room for the text it was sized for', () => {
    const text = 'Found 3 rare dinosaurs';
    const box = chatterBubble(text);
    const textWidth = text.length * CHAT_CHAR_W;
    expect(box.w).toBeGreaterThan(textWidth);
    // The anchor is inside the box, and the string still ends before the far edge.
    expect(box.textX).toBeGreaterThan(box.x);
    expect(box.textX + textWidth).toBeLessThanOrEqual(box.x + box.w);
  });

  it('puts the baseline inside the box', () => {
    const box = chatterBubble('Found 2 rare dinosaurs');
    expect(box.textY).toBeGreaterThan(box.y);
    expect(box.textY).toBeLessThan(box.y + box.h);
  });

  /**
   * The bubble is drawn relative to the drone's origin, so "above and to the
   * right" is the sign of its own coordinates — and it is what keeps the box
   * clear of the rotor discs and the ground shadow.
   */
  it('sits above and to the right of the airframe', () => {
    const box = chatterBubble('Found 1 rare dinosaur');
    expect(box.x).toBeGreaterThan(0);
    expect(box.y + box.h).toBeLessThan(0);
  });

  it('scales its offset with the airframe, so a big drone is not overlapped', () => {
    const small = chatterBubble('Found 1 rare dinosaur', 20);
    const big = chatterBubble('Found 1 rare dinosaur', 60);
    expect(big.x).toBeGreaterThan(small.x);
    expect(big.y).toBeLessThan(small.y);
    // Text size is fixed, so the box itself must not scale with the airframe.
    expect(big.w).toBe(small.w);
  });

  it('draws a closed tail path aimed back at the drone', () => {
    const box = chatterBubble('Found 4 rare dinosaurs');
    expect(box.tail).toMatch(/^M [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+ Z$/);
    // The tip is the third point: nearer the airframe than the bubble's underside.
    const ys = [...box.tail.matchAll(/-?\d+\.\d+/g)].map((m) => Number(m[0]));
    expect(ys[5]).toBeGreaterThan(box.y + box.h);
  });

  it('never collapses on an empty string', () => {
    const box = chatterBubble('');
    expect(box.w).toBeGreaterThan(0);
    expect(box.h).toBeGreaterThan(0);
  });
});

describe('droneInsets with a chat bubble', () => {
  const text = 'Found 3 rare dinosaurs';
  const box = chatterBubble(text, DRONE_SIZE);

  it('reserves more room on the right and top than the airframe alone', () => {
    const bare = droneInsets(DRONE_SIZE, DEFAULT_VARIANT);
    const withChat = droneInsets(DRONE_SIZE, DEFAULT_VARIANT, box);

    expect(withChat.right).toBeGreaterThan(bare.right);
    expect(withChat.top).toBeGreaterThan(bare.top);
    // The bubble hangs off one corner only: the other two edges are unaffected.
    expect(withChat.left).toBe(bare.left);
    expect(withChat.bottom).toBe(bare.bottom);
  });

  it('is a no-op when there is no bubble, so a silent drone flies the old route', () => {
    expect(droneInsets(DRONE_SIZE, DEFAULT_VARIANT, null)).toEqual(
      droneInsets(DRONE_SIZE, DEFAULT_VARIANT),
    );
  });

  /**
   * The point of the whole inset: a drone at the far corner of its bounds must
   * still have its bubble drawn inside the rect the bounds came from.
   */
  it('keeps the bubble on screen at the worst-case corner', () => {
    const canvas: Rect = { x: 0, y: 0, width: 1600, height: 900 };
    const bounds = insetRect(canvas, droneInsets(DRONE_SIZE, DEFAULT_VARIANT, box));

    const corner = { x: bounds.x + bounds.width, y: bounds.y };
    expect(corner.x + box.x + box.w).toBeLessThanOrEqual(canvas.x + canvas.width);
    expect(corner.y + box.y).toBeGreaterThanOrEqual(canvas.y);
  });

  it('reserves room for a longer message, so an AI-written line still fits', () => {
    const chatty = chatterBubble('Found 3 astonishingly rare dinosaurs today', DRONE_SIZE);
    expect(droneInsets(DRONE_SIZE, DEFAULT_VARIANT, chatty).right).toBeGreaterThan(
      droneInsets(DRONE_SIZE, DEFAULT_VARIANT, box).right,
    );
  });
});
