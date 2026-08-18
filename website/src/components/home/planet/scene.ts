// Geometry for the hero scene: a small planet with dinosaurs standing around its
// rim, passing a command from one to another.
//
// Everything here is pure — no DOM, no Math.random — so the markup in
// Planet.tsx is a projection of data and the timeline has stable coordinates to
// animate against.

export const VIEW = {w: 720, h: 540} as const;
export const PLANET = {cx: 360, cy: 340, r: 150} as const;

/** How far above the surface a dinosaur's head sits, in user units. */
const HEAD_HEIGHT = 72;

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
  const c = rimPoint((from + to) / 2, PLANET.r + 170);
  return `M ${r1(a.x)} ${r1(a.y)} Q ${r1(c.x)} ${r1(c.y)} ${r1(b.x)} ${r1(b.y)}`;
}

/** The halfway point of that same quadratic — where the still frame parks the chip. */
export function arcMidpoint(from: number, to: number): {x: number; y: number} {
  const a = rimPoint(from, PLANET.r + 88);
  const b = rimPoint(to, PLANET.r + 88);
  const c = rimPoint((from + to) / 2, PLANET.r + 170);
  return {
    x: 0.25 * a.x + 0.5 * c.x + 0.25 * b.x,
    y: 0.25 * a.y + 0.5 * c.y + 0.25 * b.y,
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Lay a surface feature on a sphere rather than on a disc.
 *
 * Orthographic projection: a patch of ground at distance `d` from the centre of
 * the visible disc is tilted away from the viewer, so it compresses along the
 * radial direction by `sqrt(1 - (d/r)^2)` and not at all across it. Squash by
 * that factor and continents near the limb foreshorten the way they do on a
 * globe — which is most of what makes a flat circle read as a ball.
 *
 * Returned as a transform prefix: rotate the radial direction onto x, scale x
 * alone, rotate back. The floor stops a lobe right on the limb collapsing to a
 * line and disappearing.
 */
export function sphereProject(x: number, y: number): string {
  const dx = x - PLANET.cx;
  const dy = y - PLANET.cy;
  const d = Math.hypot(dx, dy);
  const k = Math.max(0.12, Math.sqrt(Math.max(0, 1 - (d / PLANET.r) ** 2)));
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return [
    `translate(${r1(x)} ${r1(y)})`,
    `rotate(${r1(deg)})`,
    `scale(${r1(k)} 1)`,
    `rotate(${r1(-deg)})`,
    `translate(${r1(-x)} ${r1(-y)})`,
  ].join(' ');
}

/**
 * One ring of trees around the rim.
 *
 * Slots rather than free angles: `rng() * 360` clumps, and a clump on a
 * silhouette this small leaves a bald quadrant that reads as a bug rather than
 * as chance. Each tree jitters inside its own slot instead. `phase` offsets the
 * whole ring by a fraction of a slot, so the layer drawn behind the planet
 * interleaves with the one in front rather than hiding directly behind it.
 *
 * Counts stay low. A tree in every slot closes the gaps and the rim stops being
 * a horizon with trees on it and becomes a wreath.
 */
function treeRing(rng: () => number, count: number, phase: number): Tree[] {
  const step = 360 / count;
  return Array.from({length: count}, (_, i) => ({
    deg: (i + phase) * step + (rng() * 2 - 1) * step * 0.34,
    scale: 0.62 + rng() * 0.62,
    ...canopy(rng),
  }));
}

/**
 * A lumpy ball of foliage on a bare trunk.
 *
 * One crown blob with satellites ringed around it, squashed vertically so the
 * result is broader than it is tall. A single circle reads as a lollipop and a
 * triangle, at this size, as an arrowhead pointing off the planet.
 */
function canopy(rng: () => number): Pick<Tree, 'trunk' | 'puffs'> {
  // Short trunks. A tall bare stem under a round crown reads as a lollipop, and
  // a rim of them reads as a row of pins stuck into the planet.
  const trunk = 6 + rng() * 8;
  const r = 10 + rng() * 5;
  const n = 5 + Math.floor(rng() * 3);
  return {
    trunk,
    puffs: [
      {x: 0, y: -(trunk + r * 0.5), r},
      ...Array.from({length: n}, (_, i) => {
        const a = ((i + rng() * 0.7) / n) * Math.PI * 2;
        const d = r * (0.72 + rng() * 0.4);
        return {
          x: r1(Math.cos(a) * d),
          y: r1(-(trunk + r * 0.5) + Math.sin(a) * d * 0.62),
          r: r1(r * (0.48 + rng() * 0.38)),
        };
      }),
    ],
  };
}

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

/** A tree: a trunk on the rim and a cluster of canopy blobs above it. */
export interface Tree {
  deg: number;
  scale: number;
  /** Trunk height, in tree-local units with the foot at the origin. */
  trunk: number;
  /** Canopy blobs, same coordinates, y negative being up. */
  puffs: {x: number; y: number; r: number}[];
}

export interface Scenery {
  /** Landmasses, as overlapping ellipses clipped to the disc. */
  continents: {x: number; y: number; rx: number; ry: number; rot: number}[];
  /** Trees on the rim, placed the same way the animals are. */
  trees: Tree[];
  /** The same ring again, one slot out of phase, drawn behind the disc. */
  backTrees: Tree[];
  /** Low rounded hills on the rim. */
  hills: {deg: number; w: number; h: number}[];
  /** Cloud sheets lying on the surface, clipped to the disc. */
  clouds: {x: number; y: number; rx: number; ry: number; rot: number}[];
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

  // Each landmass is a cluster of overlapping lobes, not one ellipse. Single
  // ellipses at this size read as polka dots; overlapping ones union into a
  // coastline with bays and headlands.
  //
  // Centres are sampled in polar coordinates so they spread across the disc
  // rather than piling into its corners, which a square sample would do. Lobes
  // are allowed past the rim — the clip turns those into coastlines.
  const continents = Array.from({length: 5 + Math.floor(rng() * 3)}, () => {
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * PLANET.r * 0.76;
    const cx = PLANET.cx + Math.cos(a) * d;
    const cy = PLANET.cy + Math.sin(a) * d;
    return Array.from({length: 3 + Math.floor(rng() * 3)}, () => ({
      x: cx + (rng() * 2 - 1) * 26,
      y: cy + (rng() * 2 - 1) * 22,
      rx: 17 + rng() * 19,
      ry: 12 + rng() * 13,
      rot: rng() * 180,
    }));
  }).flat();

  const trees = treeRing(rng, 11, 0);
  const backTrees = treeRing(rng, 7, 0.5);

  const hills = Array.from({length: 4 + Math.floor(rng() * 3)}, () => ({
    deg: rng() * 360,
    w: 34 + rng() * 30,
    h: 8 + rng() * 7,
  }));

  // Cloud sheets lie on the surface rather than orbiting outside it: puffs in
  // open space around the rim read as debris, and it is the weather crossing the
  // disc that says "this is a planet seen from far away".
  const clouds = Array.from({length: 5 + Math.floor(rng() * 3)}, () => {
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * PLANET.r * 0.85;
    return {
      x: PLANET.cx + Math.cos(a) * d,
      y: PLANET.cy + Math.sin(a) * d,
      // Kept nearly round. Long thin ones survive the blur as streaks, and a
      // pale streak on a sphere reads as a scratch on the drawing.
      rx: 20 + rng() * 20,
      ry: 12 + rng() * 9,
      rot: rng() * 180,
    };
  });

  return {
    cast: {
      asker: {species: 'theropod', deg: spread(-58, 7), scale: 1.3, facing: 1},
      sender: {species: 'sauropod', deg: spread(52, 7), scale: 1.25, facing: -1},
      watcher: {species: pick(), deg: spread(150, 14), scale: 0.9, facing: -1},
    },
    scenery: {continents, trees, backTrees, hills, clouds},
  };
}
