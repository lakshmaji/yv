import { describe, expect, it } from 'vitest';
import { pointInPolygon, type Pt } from './geometry';
import {
  SEA_COUNTS,
  SEA_KINDS,
  SEA_STOPS,
  LEAP_SCALE,
  seaHull,
  seaLife,
  seaShape,
  swimFrames,
  type SeaCreature,
  type SeaKind,
} from './sealife';
import { WORLD_H, WORLD_W, generateWorld } from './world';

const SEEDS = [1, 7, 20260806, 88123, 999999];

function worldAt(seed: number) {
  return generateWorld(seed);
}

function lifeAt(seed: number): SeaCreature[] {
  const w = worldAt(seed);
  return seaLife(w.coast, w.islets, w.width, w.height, w.seed);
}

/** The creature as it will be at stop `i` of its own lap. */
function atStop(c: SeaCreature, i: number): SeaCreature {
  const stop = c.route[i];
  return {
    ...c,
    x: c.x + stop.dx,
    y: c.y + stop.dy,
    heading: c.heading + (stop.turn * Math.PI) / 180,
  };
}

/**
 * The hull at the top of a leap, where the animal is drawn `LEAP_SCALE` bigger.
 *
 * A fluke tip that clears the shore at rest can be over the beach at 1.22×.
 */
function airborne(c: SeaCreature): Pt[] {
  return seaHull(c).map((p) => ({
    x: c.x + (p.x - c.x) * LEAP_SCALE,
    y: c.y + (p.y - c.y) * LEAP_SCALE,
  }));
}

describe('seaLife placement', () => {
  it('puts something in the water for every seed', () => {
    for (const seed of SEEDS) {
      expect(lifeAt(seed).length, `seed ${seed}`).toBeGreaterThan(0);
    }
  });

  it('never exceeds the per-kind counts', () => {
    for (const seed of SEEDS) {
      const life = lifeAt(seed);
      for (const kind of SEA_KINDS) {
        const n = life.filter((c) => c.kind === kind).length;
        expect(n, `${kind} @ ${seed}`).toBeLessThanOrEqual(SEA_COUNTS[kind][1]);
      }
    }
  });

  /**
   * The whole point of the feature request: these are sea animals. Being outside
   * the coast ring is also what keeps them out of the rivers and the lakes, which
   * are inside it by construction — so this one assertion covers all three.
   *
   * Tested on the drawn hull rather than the centre, and at *every* stop of the
   * lap with the animal turned the way it will be turned there. A hull tested at
   * one heading says nothing about the same hull swung ninety degrees, and the
   * tight spots on a circuit are exactly the corners.
   */
  it('keeps every drawn point at sea for the whole lap — never on land, a river or a lake', () => {
    for (const seed of SEEDS) {
      const world = worldAt(seed);
      for (const creature of lifeAt(seed)) {
        for (let i = 0; i < creature.route.length; i++) {
          const at = atStop(creature, i);
          const points = [...seaHull(at), ...(creature.leap > 0 ? airborne(at) : [])];
          for (const p of points) {
            const where = `${creature.kind} stop ${i} @ ${seed}`;
            expect(pointInPolygon(p, world.coast), where).toBe(false);
            for (const islet of world.islets) {
              expect(pointInPolygon(p, islet), where).toBe(false);
            }
          }
        }
      }
    }
  });

  it('keeps every drawn point inside the frame for the whole lap', () => {
    for (const seed of SEEDS) {
      for (const creature of lifeAt(seed)) {
        for (let i = 0; i < creature.route.length; i++) {
          for (const p of seaHull(atStop(creature, i))) {
            expect(p.x, `${creature.kind} @ ${seed}`).toBeGreaterThanOrEqual(0);
            expect(p.x, `${creature.kind} @ ${seed}`).toBeLessThanOrEqual(WORLD_W);
            expect(p.y, `${creature.kind} @ ${seed}`).toBeGreaterThanOrEqual(0);
            expect(p.y, `${creature.kind} @ ${seed}`).toBeLessThanOrEqual(WORLD_H);
          }
        }
      }
    }
  });

  it('keeps two animals apart, so neither reads as one broken shape', () => {
    for (const seed of SEEDS) {
      const life = lifeAt(seed);
      for (let i = 0; i < life.length; i++) {
        for (let j = i + 1; j < life.length; j++) {
          const gap = Math.hypot(life[i].x - life[j].x, life[i].y - life[j].y);
          expect(gap, `seed ${seed}`).toBeGreaterThanOrEqual(150);
        }
      }
    }
  });

  it('is stable for a seed and differs between seeds', () => {
    expect(lifeAt(7)).toEqual(lifeAt(7));
    expect(lifeAt(7)).not.toEqual(lifeAt(8));
  });

  it('is empty for a degenerate coast', () => {
    expect(seaLife([], [], WORLD_W, WORLD_H, 1)).toEqual([]);
  });
});

describe('the circuit', () => {
  it('is a closed lap of the right length', () => {
    for (const seed of SEEDS) {
      for (const c of lifeAt(seed)) {
        // One extra stop, which repeats the first: that is what closes the loop.
        expect(c.route, `${c.kind} @ ${seed}`).toHaveLength(SEA_STOPS + 1);
        expect(c.route[0].dx).toBe(0);
        expect(c.route[0].dy).toBe(0);
        expect(c.route[0].turn).toBe(0);
        const last = c.route[c.route.length - 1];
        expect(last.dx, `${c.kind} @ ${seed}`).toBeCloseTo(0, 6);
        expect(last.dy, `${c.kind} @ ${seed}`).toBeCloseTo(0, 6);
      }
    }
  });

  /**
   * A lap turns the animal all the way round, once. Wrapping the angle instead
   * would leave a seam where it spins on the spot to catch up — which is exactly
   * what "unwrapped" in `toStops` is there to prevent, and it is invisible in a
   * still frame.
   */
  it('accumulates one full turn rather than wrapping', () => {
    for (const seed of SEEDS) {
      for (const c of lifeAt(seed)) {
        const total = c.route[c.route.length - 1].turn;
        expect(Math.abs(total), `${c.kind} @ ${seed}`).toBeCloseTo(360, 0);
      }
    }
  });

  it('turns gradually, never snapping between stops', () => {
    for (const seed of SEEDS) {
      for (const c of lifeAt(seed)) {
        for (let i = 1; i < c.route.length; i++) {
          const step = Math.abs(c.route[i].turn - c.route[i - 1].turn);
          expect(step, `${c.kind} stop ${i} @ ${seed}`).toBeLessThan(90);
        }
      }
    }
  });

  it('actually travels — a lap is not a bob in place', () => {
    for (const seed of SEEDS) {
      for (const c of lifeAt(seed)) {
        const reach = Math.max(...c.route.map((s) => Math.hypot(s.dx, s.dy)));
        expect(reach, `${c.kind} @ ${seed}`).toBeGreaterThan(200);
      }
    }
  });

  it('swims slowly enough to be scenery rather than a cursor', () => {
    for (const seed of SEEDS) {
      for (const c of lifeAt(seed)) {
        expect(c.dur, `${c.kind} @ ${seed}`).toBeGreaterThan(30);
      }
    }
  });

  it('gives a dolphin a leap on its own clock, and nothing else one', () => {
    for (const seed of SEEDS) {
      for (const c of lifeAt(seed)) {
        if (c.kind === 'dolphin') {
          expect(c.leap, `@ ${seed}`).toBeGreaterThan(5);
          expect(c.leap, `@ ${seed}`).toBeLessThan(11);
        } else {
          expect(c.leap, `${c.kind} @ ${seed}`).toBe(0);
        }
      }
    }
  });

  it('beats its tail on its own clock, not on the lap', () => {
    for (const seed of SEEDS) {
      for (const c of lifeAt(seed)) {
        expect(c.beat, `${c.kind} @ ${seed}`).toBeGreaterThan(1);
        expect(c.beat, `${c.kind} @ ${seed}`).toBeLessThan(4.5);
      }
    }
  });
});

describe('the wake', () => {
  /**
   * The fix for the heartbeat. A complete ring expanding out of an animal that
   * is barely moving is a sonar ping: it is symmetric, so nothing about it says
   * which way the animal is going, and all that is left to read is the throb.
   */
  it('trails astern and never surrounds the animal', () => {
    for (const kind of SEA_KINDS) {
      const c = specimen(kind, 0.7);
      const ahead = { x: Math.cos(c.heading), y: Math.sin(c.heading) };
      for (const arc of seaShape(c).wake) {
        expect(arc, kind).not.toContain('Z');
        for (const p of onCurvePoints(arc)) {
          const along = (p.x - c.x) * ahead.x + (p.y - c.y) * ahead.y;
          expect(along, `${kind} wake point ahead of the body`).toBeLessThan(0);
        }
      }
    }
  });

  it('is inside the hull, so a wake cannot wash over a beach', () => {
    for (const kind of SEA_KINDS) {
      const c = specimen(kind);
      const reach = Math.max(...seaHull(c).map((p) => Math.hypot(p.x - c.x, p.y - c.y)));
      for (const arc of seaShape(c).wake) {
        for (const p of onCurvePoints(arc)) {
          expect(Math.hypot(p.x - c.x, p.y - c.y), kind).toBeLessThanOrEqual(reach + 0.001);
        }
      }
    }
  });
});

describe('swimFrames', () => {
  it('emits one keyframe per stop, in order, over the whole cycle', () => {
    for (const c of lifeAt(20260806)) {
      const frames = swimFrames(c);
      expect(frames).toHaveLength(c.route.length);
      expect(frames[0].offset).toBe(0);
      expect(frames[frames.length - 1].offset).toBe(1);
      for (let i = 1; i < frames.length; i++) {
        expect(frames[i].offset).toBeGreaterThan(frames[i - 1].offset);
      }
      for (const frame of frames) {
        expect(frame.transform).not.toContain('NaN');
        expect(frame.transform).toMatch(/^translate\(.+\) rotate\(.+deg\)$/);
      }
    }
  });

  /**
   * The other half of "always forward". The leap itself no longer translates —
   * a keyframe loop has to return to its start, so every jump used to be
   * followed by the dolphin sliding backwards to its take-off point. The travel
   * is the lap, which only goes one way, and the two are geared together: one
   * leap per leg, with the leg eased so the surge happens under the arc.
   */
  it('gears a leaper\'s lap to its leaps, and surges rather than cruising', () => {
    for (const seed of SEEDS) {
      for (const c of lifeAt(seed)) {
        const frames = swimFrames(c);
        if (c.kind === 'dolphin') {
          expect(c.dur, `@ ${seed}`).toBeCloseTo(c.leap * SEA_STOPS, 6);
          for (const f of frames) expect(f.easing).toBe('ease-in-out');
        } else {
          for (const f of frames) expect(f.easing).toBe('linear');
        }
      }
    }
  });

  it('has nothing to animate for a creature with no route', () => {
    const [c] = lifeAt(7);
    expect(swimFrames({ ...c, route: [] })).toEqual([]);
  });
});

/**
 * On-curve points of a path: the moveto, then the endpoint of each cubic.
 *
 * Control points are skipped deliberately — they sit off the curve by design, so
 * a wake drawn perfectly astern would still fail a containment check that counted
 * them. Same helper sea.test.ts and river.test.ts use.
 */
function onCurvePoints(d: string): Pt[] {
  const pts: Pt[] = [];
  const move = d.match(/^M\s+(-?[\d.]+)\s+(-?[\d.]+)/);
  if (move) pts.push({ x: Number(move[1]), y: Number(move[2]) });
  const cubic = /C\s+-?[\d.]+\s+-?[\d.]+,\s*-?[\d.]+\s+-?[\d.]+,\s*(-?[\d.]+)\s+(-?[\d.]+)/g;
  for (const m of d.matchAll(cubic)) pts.push({ x: Number(m[1]), y: Number(m[2]) });
  return pts;
}

/** A creature of each kind, drawn at a known place and heading. */
function specimen(kind: SeaKind, heading = 0): SeaCreature {
  return {
    kind,
    x: 500,
    y: 400,
    size: 30,
    heading,
    route: [],
    dur: 60,
    beat: 2,
    leap: kind === 'dolphin' ? 8 : 0,
    phase: 0,
    colors: { body: '#1', dark: '#2', light: '#3', skin: '#4' },
  };
}

describe('seaShape', () => {
  it('draws a body, a lit back and a pair of eyes for every kind', () => {
    for (const kind of SEA_KINDS) {
      const shape = seaShape(specimen(kind));
      expect(shape.body, kind).toMatch(/^M /);
      expect(shape.body, kind).not.toContain('NaN');
      expect(shape.eyes, kind).toHaveLength(2);
      expect(shape.gloss.rx, kind).toBeGreaterThan(0);
    }
  });

  /**
   * Two hinges, not one. The after-body is what turns a tail-wag on a rigid plank
   * into a wave running the length of the animal.
   */
  it('hinges the cetaceans at the shoulder as well as the tail', () => {
    for (const kind of ['whale', 'dolphin'] as const) {
      const c = specimen(kind);
      const shape = seaShape(c);
      expect(shape.flex, kind).not.toBeNull();
      // The shoulder is forward of the peduncle: the wave travels tail-ward.
      expect(shape.flexPivot.x, kind).toBeGreaterThan(shape.flukePivot.x);
    }
    expect(seaShape(specimen('turtle')).flex).toBeNull();
  });

  it('gives the swimmers a fluke and the turtle a shell', () => {
    expect(seaShape(specimen('whale')).fluke).not.toBeNull();
    expect(seaShape(specimen('dolphin')).fluke).not.toBeNull();
    expect(seaShape(specimen('turtle')).fluke).toBeNull();

    expect(seaShape(specimen('turtle')).shell).not.toBeNull();
    expect(seaShape(specimen('turtle')).plates.length).toBeGreaterThan(4);
    expect(seaShape(specimen('whale')).shell).toBeNull();
  });

  it('rows the turtle with four legs, all of them animated', () => {
    const turtle = seaShape(specimen('turtle'));
    expect(turtle.fins).toHaveLength(4);
    for (const fin of turtle.fins) expect(fin.amp).toBeGreaterThan(0);

    const dolphin = seaShape(specimen('dolphin'));
    expect(dolphin.fins).toHaveLength(2);
  });

  /**
   * The gait: a pair strokes outward together, and a turtle's back legs kick
   * shallower and on the opposite beat from its front ones. Both are what stop
   * four identical paddles reading as one shape flapping.
   */
  it('gives a turtle a gait rather than four identical paddles', () => {
    const [frontL, frontR, backL, backR] = seaShape(specimen('turtle')).fins;
    expect(frontL.dir).toBe(-frontR.dir);
    expect(backL.dir).toBe(-backR.dir);
    expect(backL.dir).toBe(-frontL.dir);
    expect(backL.amp).toBeLessThan(frontL.amp);
    expect(backL.trailing).toBe(true);
    expect(frontL.trailing).toBe(false);
  });

  it('hinges every limb at its own root, not at the body centre', () => {
    for (const kind of SEA_KINDS) {
      const c = specimen(kind);
      for (const fin of seaShape(c).fins) {
        expect(Math.hypot(fin.pivot.x - c.x, fin.pivot.y - c.y), kind).toBeGreaterThan(0);
      }
    }
  });

  it('only the dolphin leaves the water, so only it splashes', () => {
    expect(seaShape(specimen('dolphin')).splash).not.toBeNull();
    expect(seaShape(specimen('dolphin')).airShadow).not.toBeNull();
    expect(seaShape(specimen('whale')).splash).toBeNull();
    expect(seaShape(specimen('turtle')).splash).toBeNull();
    expect(seaShape(specimen('turtle')).airShadow).toBeNull();
  });

  /** The shadow is the leap: if it sat under the animal there would be nothing
   *  to see, since from overhead height itself is invisible. */
  it('throws the airborne shadow clear of the body, away from the light', () => {
    const c = specimen('dolphin');
    const shadow = seaShape(c).airShadow!;
    expect(shadow.cx).toBeGreaterThan(c.x);
    expect(shadow.cy).toBeGreaterThan(c.y);
  });

  it('only the whale blows', () => {
    expect(seaShape(specimen('whale')).spout).not.toBeNull();
    expect(seaShape(specimen('dolphin')).spout).toBeNull();
    expect(seaShape(specimen('turtle')).spout).toBeNull();
  });

  /** The ring is spray thrown from the blowhole, so it belongs on the head. */
  it('blows from the head, not from the middle of the animal', () => {
    const c = specimen('whale');
    const blow = seaShape(c).spout!;
    expect(blow.cx).toBeGreaterThan(c.x);
    expect(blow.cy).toBeCloseTo(c.y, 6);
  });

  /**
   * Every body is authored as one half and mirrored, so the two sides cannot
   * drift apart through a mistyped coordinate. The eyes are the visible proof:
   * they are one entry in the table, placed twice.
   */
  it('is symmetric about the body axis', () => {
    for (const kind of SEA_KINDS) {
      const c = specimen(kind);
      const [left, right] = seaShape(c).eyes;
      const dl = Math.hypot(left.cx - c.x, left.cy - c.y);
      const dr = Math.hypot(right.cx - c.x, right.cy - c.y);
      expect(dl, kind).toBeCloseTo(dr, 6);
      expect(left.r, kind).toBe(right.r);
    }
  });

  it('turns with its heading rather than staying axis-aligned', () => {
    const flat = seaShape(specimen('dolphin', 0));
    const turned = seaShape(specimen('dolphin', Math.PI / 2));
    expect(turned.body).not.toBe(flat.body);
    // Same animal, same distance from its own centre — only the bearing changed.
    const reach = (s: ReturnType<typeof seaShape>) =>
      Math.hypot(s.flukePivot.x - 500, s.flukePivot.y - 400);
    expect(reach(turned)).toBeCloseTo(reach(flat), 6);
  });

  it('scales with size', () => {
    const small = seaShape({ ...specimen('whale'), size: 10 });
    const big = seaShape({ ...specimen('whale'), size: 40 });
    expect(big.gloss.rx).toBeCloseTo(small.gloss.rx * 4, 6);
  });
});

describe('seaHull', () => {
  it('covers every drawn part, so placement cannot miss a fluke tip', () => {
    for (const kind of SEA_KINDS) {
      const c = specimen(kind);
      const hull = seaHull(c);
      const reach = Math.max(...hull.map((p: Pt) => Math.hypot(p.x - c.x, p.y - c.y)));

      // The furthest thing the shape draws, measured off the geometry itself
      // rather than trusted from a constant — the two drift apart, which is the
      // bug DRONE_EXTENT existed to catch on the drone.
      const shape = seaShape(c);
      const drawn = [
        ...shape.eyes.map((e) => ({ x: e.cx, y: e.cy })),
        { x: shape.ripple.cx + shape.ripple.rx, y: shape.ripple.cy },
        shape.flukePivot,
        ...shape.fins.map((f) => f.pivot),
      ];
      for (const p of drawn) {
        expect(Math.hypot(p.x - c.x, p.y - c.y), kind).toBeLessThanOrEqual(reach + 0.001);
      }
    }
  });

  it('moves with the creature', () => {
    const a = seaHull(specimen('whale'));
    const b = seaHull({ ...specimen('whale'), x: 900 });
    for (let i = 0; i < a.length; i++) expect(b[i].x - a[i].x).toBeCloseTo(400, 6);
  });
});
