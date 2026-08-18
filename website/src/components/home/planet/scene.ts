// Geometry for the hero scene: a small planet with dinosaurs standing around its
// rim, passing a command from one to another.
//
// Everything here is pure — no DOM, no Math.random — so the markup in
// Planet.tsx is a projection of data and the timeline has stable coordinates to
// animate against.

export const VIEW = {w: 720, h: 580} as const;
export const PLANET = {cx: 360, cy: 370, r: 150} as const;

/** How far above the surface a dinosaur's head sits, in user units. */
const HEAD_HEIGHT = 62;

export const DIALOG = {
  question: 'how do I run the server?',
  command: 'docker compose up',
  thanks: 'thank you!',
} as const;

/**
 * Seeded RNG. The seed is picked once per mount so every visit gets a different
 * world, while a single visit stays put — a world that reshuffled on each React
 * render would flicker.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** A point `radius` out from the planet centre, `deg` measured clockwise from north. */
export function rimPoint(deg: number, radius: number): {x: number; y: number} {
  return {
    x: PLANET.cx + radius * Math.sin(rad(deg)),
    y: PLANET.cy - radius * Math.cos(rad(deg)),
  };
}

/**
 * Stand something on the surface at `deg`, tilted to match the curve.
 *
 * Three transforms in sequence: to the centre, around by the angle, then out to
 * the rim along the now-rotated axis. `facing` mirrors the animal so it can look
 * at whoever it is talking to; it is the last term so it flips the drawing, not
 * the placement.
 */
export function standOn(deg: number, scale = 1, facing: 1 | -1 = 1): string {
  return [
    `translate(${PLANET.cx} ${PLANET.cy})`,
    `rotate(${deg})`,
    `translate(0 ${-PLANET.r})`,
    `scale(${scale * facing} ${scale})`,
  ].join(' ');
}

/** Where a speech bubble's tail should point, in scene coordinates. */
export function speechAnchor(deg: number, scale: number): {x: number; y: number} {
  return rimPoint(deg, PLANET.r + HEAD_HEIGHT * scale + 6);
}

/**
 * The path a command takes between two animals: a quadratic bulging away from
 * the planet, so it arcs over the pole rather than cutting through the world.
 */
export function arcBetween(from: number, to: number): string {
  const a = rimPoint(from, PLANET.r + 88);
  const b = rimPoint(to, PLANET.r + 88);
  const c = rimPoint((from + to) / 2, PLANET.r + 205);
  return `M ${r1(a.x)} ${r1(a.y)} Q ${r1(c.x)} ${r1(c.y)} ${r1(b.x)} ${r1(b.y)}`;
}

/** The halfway point of that same quadratic — where the still frame parks the chip. */
export function arcMidpoint(from: number, to: number): {x: number; y: number} {
  const a = rimPoint(from, PLANET.r + 88);
  const b = rimPoint(to, PLANET.r + 88);
  const c = rimPoint((from + to) / 2, PLANET.r + 205);
  return {
    x: 0.25 * a.x + 0.5 * c.x + 0.25 * b.x,
    y: 0.25 * a.y + 0.5 * c.y + 0.25 * b.y,
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export type Species = 'theropod' | 'sauropod' | 'stegosaur';

export interface Actor {
  species: Species;
  deg: number;
  scale: number;
  facing: 1 | -1;
}

export interface Cast {
  /** Asks the question and, once the command lands, says thanks. */
  asker: Actor;
  /** Knows the command and sends it. */
  sender: Actor;
  /** Neither — it is here so the planet is populated rather than staged. */
  watcher: Actor;
}

export interface Scenery {
  /** Landmasses, as overlapping ellipses clipped to the disc. */
  continents: {x: number; y: number; rx: number; ry: number; rot: number}[];
  /** Conifers on the rim, placed the same way the animals are. */
  trees: {deg: number; scale: number}[];
  /** Low rounded hills on the rim. */
  hills: {deg: number; w: number; h: number}[];
  /** Cloud puffs orbiting just above the surface. */
  clouds: {deg: number; lift: number; w: number}[];
}

export interface Scene {
  cast: Cast;
  scenery: Scenery;
}

/**
 * The whole world for one seed.
 *
 * The three animals keep their rough stations — upper left, upper right, lower
 * right — and only jitter within them. Fully random angles looked like an
 * accident: the arc is the subject, and it needs two animals far enough apart
 * for it to be a journey.
 */
export function buildScene(seed: number): Scene {
  const rng = mulberry32(seed);
  const spread = (base: number, by: number) => base + (rng() * 2 - 1) * by;

  const others: Species[] = ['sauropod', 'stegosaur', 'theropod'];
  const pick = () => others[Math.floor(rng() * others.length)];

  const continents = Array.from({length: 4 + Math.floor(rng() * 3)}, () => {
    // Sampled in polar coordinates so the blobs spread across the disc rather
    // than piling into its corners, which a square sample would do. Some are
    // allowed past the rim: the clip turns those into coastlines.
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * PLANET.r * 0.78;
    return {
      x: PLANET.cx + Math.cos(a) * d,
      y: PLANET.cy + Math.sin(a) * d,
      rx: 24 + rng() * 30,
      ry: 17 + rng() * 20,
      rot: rng() * 180,
    };
  });

  const trees = Array.from({length: 6 + Math.floor(rng() * 4)}, () => ({
    deg: rng() * 360,
    scale: 0.6 + rng() * 0.4,
  }));

  const hills = Array.from({length: 4 + Math.floor(rng() * 3)}, () => ({
    deg: rng() * 360,
    w: 34 + rng() * 30,
    h: 8 + rng() * 7,
  }));

  const clouds = Array.from({length: 4}, (_, i) => ({
    deg: i * 90 + rng() * 60,
    lift: 22 + rng() * 22,
    w: 22 + rng() * 16,
  }));

  return {
    cast: {
      asker: {species: 'theropod', deg: spread(-58, 7), scale: 1.3, facing: 1},
      sender: {species: 'sauropod', deg: spread(52, 7), scale: 1.25, facing: -1},
      watcher: {species: pick(), deg: spread(150, 14), scale: 0.9, facing: -1},
    },
    scenery: {continents, trees, hills, clouds},
  };
}
