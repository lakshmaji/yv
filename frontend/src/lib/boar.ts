// The launch splash: a boar in profile, head and shoulders, drawn as a neon
// wireframe.
//
// Geometry only — no DOM, no Math.random, no anime.js. Same split the landscape
// uses (see lib/landscape/shapes.ts): the numbers live here where a test can
// reach them, and Splash.tsx is a dumb projection of what this file returns.
//
// Every path is absolute M/C/Z. That is what lets the tests pair the numbers off
// as coordinates and prove nothing escapes the viewBox — a stroke clipped at the
// panel edge is the one defect that looks deliberate enough to ship.
//
// It faces LEFT, and the whole animal is built on one idea: a boar in profile is
// a WEDGE. The snout tip is the lowest, furthest-forward point and the line runs
// up and back from there to a high shoulder hump. Get that slope wrong and no
// amount of detail rescues it — the frontal versions of this drawing were
// abandoned after reading, in turn, as a mandrill and as a cat, both times
// because the outline was a circle rather than a shape with a direction.

import { makeRng, hashText } from './landscape/rng';
import { shade } from './landscape/palette';

/**
 * The coordinate space every path below is expressed in.
 *
 * Wider and taller than the drawing needs: the neon filter blurs well outside
 * the strokes, and the SVG root clips at the viewBox, so a snug box shears the
 * glow off flat along an edge and the hump looks cut.
 */
export const BOAR_VIEWBOX = { w: 440, h: 300 } as const;

/**
 * The splash's own colours, deliberately not the `--accent` / `--surface` CSS
 * variables. Same reasoning as landscape/palette.ts: this is a picture with its
 * own light rather than a chrome surface, and tying it to the theme would flatten
 * it to the colour of a button.
 */
export const NEON = {
  ink: '#f2fbff',
  bone: '#d3e7f4',
  /**
   * The animal's own colour — an opaque dark slate, not a wash.
   *
   * The facets used to be low-opacity cyan and violet over the backdrop, which
   * is why the boar came out mauve: the chroma ghosts tint whatever they copy,
   * and copying a translucent body tinted the whole animal. The body is now
   * solid and the ghosts copy only the linework, which is what a channel split
   * does to a neon sign in the first place.
   */
  body: '#313647',
  cyan: '#22e8ff',
  magenta: '#ff2fb9',
  violet: '#8b5cf6',
  amber: '#ffb020',
  backdrop: '#050810',
  grid: '#12314a',
} as const;

/**
 * How far the cyan and magenta ghost copies are pulled off centre, in viewBox
 * units. Chromatic split is the cheapest thing on screen that reads instantly as
 * "CRT", and one number keeps the two copies symmetric.
 */
export const CHROMA_OFFSET = 2.6;

/**
 * Local design hold — TEMPORARY, flip to `false` once the drawing is signed off.
 *
 * While it is on, the splash plays its full sequence and then simply stays: it
 * never dismisses itself, and the dev once-per-session skip is disabled so every
 * hot reload replays it. Click to run it again, Escape to get into the app.
 *
 * A constant rather than a setting or an env var on purpose. It has to be a
 * single visible line that a reviewer will trip over on the way past — a flag
 * hidden in a `.env` is one that ships enabled, and shipping this enabled means
 * an app nobody can get into.
 */
export const HOLD_FOR_DESIGN = true;

/**
 * Every beat of the 2.5s sequence, in milliseconds from the splash appearing.
 *
 * Kept as data rather than inline in the timeline so the durations are visible
 * in one place and a test can assert they still add up to `total` — a beat that
 * silently overruns the exit would leave the splash on screen with the app
 * already usable behind it.
 */
export const SPLASH = {
  gridIn: 260,
  drawStart: 200,
  /** Per stroke, not for the whole wireframe — they overlap by `drawStagger`. */
  drawDur: 520,
  drawStagger: 15,
  facetsAt: 900,
  facetsDur: 600,
  glitchAt: 1300,
  glitchDur: 340,
  eyeAt: 1500,
  sparksAt: 1540,
  markAt: 1800,
  markDur: 380,
  exitAt: 2200,
  exitDur: 300,
  total: 2500,
  /** Reduced motion: no timeline at all, just a held still and a plain fade. */
  reducedHold: 1000,
  reducedFade: 400,
} as const;

export type StrokeRole = 'silhouette' | 'interior' | 'detail' | 'bristle' | 'tusk';

export interface BoarStroke {
  id: string;
  d: string;
  color: string;
  width: number;
  role: StrokeRole;
  /**
   * Drawn *behind* the body rather than on it. Only the far tusk: distance on a
   * flat drawing is occlusion, and a smaller paler copy sitting on top of the
   * muzzle reads as a second tusk on the same side of the head, not one on the
   * other side of it.
   */
  behind?: boolean;
  /** Closed shapes get a faint wash; open contour lines must not. */
  closed: boolean;
  /**
   * Set only on the tusks. They are the one part of the animal that is a solid
   * object rather than a contour, and drawn as outlines they came out as loops
   * of wire hanging off the jaw. Kept translucent by the component: at full
   * opacity they stop being ivory and become flat grey slabs with no form.
   */
  fill?: string;
}

export interface BoarFacet {
  id: string;
  d: string;
  color: string;
  opacity: number;
}

/**
 * The eyes, by id. One, in profile — it stays an array because Splash.tsx lights
 * the whole set on a single beat, which is what the frontal version needed and
 * what a second eye would need again.
 */
export const EYE_IDS = ['eye'] as const;

// ---------------------------------------------------------------------------
// The drawing. Facing left.
// ---------------------------------------------------------------------------

/**
 * The outline, walked from the snout along the back and round under the jaw.
 *
 * Split into named segments rather than one path because the draw order is the
 * point of the reveal — and because the two segments carrying the whole animal,
 * `muzzle` and `back`, are worth being able to find.
 */
const SILHOUETTE: ReadonlyArray<readonly [string, string]> = [
  // The blunt, near-vertical snout disc. This is the single feature that says
  // "pig": taper the front to a point and the same outline reads as a whale,
  // which is exactly what the first version of this file did.
  ['snoutDisc', 'M70 122 C62 134, 62 158, 68 172'],
  ['muzzle', 'M70 122 C98 114, 126 108, 152 102'],
  ['forehead', 'M152 102 C180 92, 208 78, 244 56'],
  ['crown', 'M244 56 C256 60, 264 66, 274 66'],
  // The shoulder hump: a wild boar's back rises behind the skull instead of
  // running level like a farm pig's, and in profile it is the second thing
  // after the snout that names the animal.
  ['hump', 'M274 66 C290 58, 306 46, 326 46 C354 48, 378 68, 394 98'],
  ['back', 'M394 98 C402 142, 402 200, 396 244'],
  ['chest', 'M396 244 C360 258, 320 262, 288 258 C254 254, 226 250, 202 244'],
  ['jaw', 'M202 244 C176 238, 152 228, 134 214'],
  ['chin', 'M134 214 C112 202, 86 188, 68 172'],
];

/** Creases inside the outline. */
const INTERIOR: ReadonlyArray<readonly [string, string]> = [
  ['cheekCrease', 'M152 102 C164 134, 168 170, 162 208'],
  ['jowlCrease', 'M202 244 C216 222, 238 210, 264 208'],
  // Small, pointed and set high — a boar's ear, not a pig's flap.
  ['ear', 'M240 62 C244 36, 250 22, 258 20 C268 32, 270 52, 264 70'],
  ['earInner', 'M248 56 C250 40, 254 30, 259 28'],
  ['browRidge', 'M176 98 C186 101, 196 103, 205 109'],
  ['humpCrease', 'M274 66 C290 74, 306 64, 324 50'],
  ['shoulderLine', 'M324 58 C338 112, 342 182, 332 244'],
];

const DETAIL: ReadonlyArray<readonly [string, string]> = [
  ['nostril', 'M72 134 C78 130, 86 132, 89 140'],
  // The mouth the tusks come out of. Without it they are hooks leaning against
  // the head — the lesson the frontal version had to learn the same way.
  ['mouth', 'M68 156 C98 172, 128 186, 158 198'],
  ['iris', 'M184 108 C189 105, 196 106, 197 111 C193 115, 186 114, 184 108 Z'],
];

/**
 * The tusks: a big near one and a small far one, set well apart.
 *
 * They used to be near-identical crescents overlapping each other, which reads
 * as one thick tusk badly drawn. A boar has a pair, and in profile the far one
 * is foreshortened, further back along the jaw and partly hidden by the muzzle
 * — so the far tusk is smaller, rooted deeper, drawn dimmer and rendered
 * BEHIND the body. Distance on a flat drawing is occlusion; a smaller paler
 * copy sitting on top of the muzzle is just a second tusk on the same side.
 *
 * Tapered crescents rather than strokes: a tusk has a thick root and a point,
 * and a constant-width line reads as a whisker. Their tips finish *above* the
 * muzzle line — kept politely below they read as teeth, and the animal stops
 * being a boar.
 */
const TUSK_NEAR: ReadonlyArray<readonly [string, string]> = [
  ['tuskNear', 'M140 198 C118 194, 96 174, 86 140 C78 114, 82 88, 92 74 C100 82, 96 112, 102 144 C110 174, 124 188, 146 190 Z'],
];

const TUSK_FAR: ReadonlyArray<readonly [string, string]> = [
  ['tuskFar', 'M170 208 C156 204, 145 190, 141 170 C138 154, 142 142, 149 138 C149 150, 148 164, 152 178 C157 192, 164 200, 174 202 Z'],
];

/**
 * The eye, last of all, and built from parts rather than as one lozenge: an
 * outline, a filled iris, a pupil and a glint. The single stroked almond it
 * replaces had nothing inside it, so at any size it read as a drawn mark on the
 * head rather than as something looking back.
 *
 * The glint is what does most of the work — it is the only pure-white spot on
 * the animal, and it is what makes the eye wet instead of flat.
 */
const EYES: ReadonlyArray<readonly [string, string]> = [
  ['eye', 'M175 111 C181 100, 198 100, 204 111 C197 121, 182 121, 175 111 Z'],
  ['eyeIris', 'M189 104 C193 104, 196 107, 196 111 C196 115, 193 118, 189 118 C185 118, 182 115, 182 111 C182 107, 185 104, 189 104 Z'],
  ['eyePupil', 'M189 107 C191 107, 193 109, 193 111 C193 113, 191 115, 189 115 C187 115, 185 113, 185 111 C185 109, 187 107, 189 107 Z'],
  ['eyeGlint', 'M186 107 C188 107, 189 108, 189 109 C189 110, 188 111, 186 111 C185 111, 184 110, 184 109 C184 108, 185 107, 186 107 Z'],
];

/**
 * The bristle bed, walked so the outward normal points away from the animal —
 * see `alongSpine`. It runs from the crown back over the hump, which is where a
 * boar's crest actually is, and it starts *behind* the ear: bristles rooted
 * where the ear is drawn grow straight through it.
 */
const MANE_SPINE: ReadonlyArray<readonly [number, number]> = [
  [270, 64], [296, 54], [326, 48], [356, 58], [380, 78],
];

const BRISTLE_COUNT = 12;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * A point and outward normal at fraction `t` along the spine.
 *
 * Straight-line interpolation over the control points, not a curve: the spine is
 * only ever used to stand short bristles on, so the few px a bezier would move a
 * root by is invisible, and the polyline gives an exact normal for free. Which
 * side "outward" is falls out of the winding, so the spine is written in the
 * direction that puts it on the outside.
 */
function alongSpine(t: number): { x: number; y: number; nx: number; ny: number } {
  const span = MANE_SPINE.length - 1;
  const scaled = Math.min(t, 0.999999) * span;
  const i = Math.floor(scaled);
  const f = scaled - i;
  const [ax, ay] = MANE_SPINE[i];
  const [bx, by] = MANE_SPINE[i + 1];
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x: lerp(ax, bx, f),
    y: lerp(ay, by, f),
    nx: dy / len,
    ny: -dx / len,
  };
}

function maneBristles(): BoarStroke[] {
  const rng = makeRng(hashText('yv-boar-mane'));
  const out: BoarStroke[] = [];
  for (let i = 0; i < BRISTLE_COUNT; i++) {
    const t = (i + 0.5) / BRISTLE_COUNT;
    const { x, y, nx, ny } = alongSpine(t);
    // Longest over the hump — a crest that is one length the whole way back
    // reads as a comb rather than as fur.
    const taper = 0.5 + 0.5 * Math.sin(t * Math.PI);
    const len = rng.range(16, 30) * taper;
    // Lean each bristle back along the spine, and jitter it, so they splay.
    const lean = rng.range(0.15, 0.5);
    const tipX = x + nx * len - lean * len * ny;
    const tipY = y + ny * len + lean * len * nx;
    const f = (n: number) => n.toFixed(1);
    out.push({
      id: `bristle${i}`,
      d: `M${f(x)} ${f(y)} C${f(x + nx * len * 0.4)} ${f(y + ny * len * 0.4)}, ${f(lerp(x, tipX, 0.7))} ${f(lerp(y, tipY, 0.7))}, ${f(tipX)} ${f(tipY)}`,
      color: i % 3 === 0 ? NEON.magenta : NEON.cyan,
      width: 1.7,
      role: 'bristle',
      closed: false,
    });
  }
  return out;
}

function seg(
  src: ReadonlyArray<readonly [string, string]>,
  role: StrokeRole,
  color: string,
  width: number,
): BoarStroke[] {
  return src.map(([id, d]) => ({ id, d, color, width, role, closed: d.trimEnd().endsWith('Z') }));
}

/**
 * Every stroke of the wireframe, in the order it is drawn on.
 *
 * The order is the reveal: the outline first so the animal is recognisable
 * early, then its creases and its crest, then the tusks, and the eye last. It is
 * asserted in the tests because reordering the arrays above is a one-line change
 * that would silently ruin the only timing the splash has.
 */
export function boarStrokes(): BoarStroke[] {
  const [eye, iris, pupil, glint] = seg(EYES, 'detail', NEON.ink, 1.8);
  return [
    // The far tusk first, because it is drawn first: it sits behind the body.
    ...seg(TUSK_FAR, 'tusk', shade(NEON.bone, -0.34), 1.8)
      .map(t => ({ ...t, fill: shade(NEON.bone, -0.42), behind: true })),
    ...seg(SILHOUETTE, 'silhouette', NEON.ink, 3.2),
    ...seg(INTERIOR, 'interior', NEON.cyan, 2),
    ...seg(DETAIL, 'detail', NEON.cyan, 1.6),
    ...maneBristles(),
    ...seg(TUSK_NEAR, 'tusk', NEON.ink, 2.4).map(t => ({ ...t, fill: NEON.bone })),
    { ...eye, fill: shade(NEON.body, -0.5) },
    { ...iris, color: NEON.amber, width: 1.2, fill: NEON.amber },
    { ...pupil, color: shade(NEON.body, -0.7), width: 0.8, fill: shade(NEON.body, -0.7) },
    { ...glint, color: NEON.ink, width: 0.6, fill: NEON.ink },
  ];
}

/**
 * Flat facets washed in behind the strokes. Without them the boar is pure
 * outline and reads as a diagram; a handful of low-opacity planes give it mass
 * without turning it into a filled illustration.
 *
 * They are written to **overlap** along every shared edge. Two dark washes that
 * merely meet leave a hairline of backdrop between them, and at this contrast
 * that hairline reads as a black seam splitting the animal in half.
 */
export function boarFacets(): BoarFacet[] {
  return [
    {
      id: 'muzzleFacet',
      d: 'M70 122 C98 114, 126 108, 152 102 C164 134, 168 170, 162 208 C130 202, 96 188, 68 172 C62 158, 62 134, 70 122 Z',
      color: shade(NEON.body, 0.1),
      opacity: 1,
    },
    {
      id: 'cheekFacet',
      d: 'M152 102 C180 92, 208 78, 244 56 C262 94, 270 150, 262 208 C240 210, 218 222, 202 244 C178 238, 170 228, 162 208 C168 170, 164 134, 152 102 Z',
      color: NEON.body,
      opacity: 1,
    },
    {
      id: 'earFacet',
      d: 'M240 62 C244 36, 250 22, 258 20 C268 32, 270 52, 264 70 Z',
      color: shade(NEON.body, -0.22),
      opacity: 1,
    },
    {
      id: 'humpFacet',
      d: 'M274 66 C290 58, 306 46, 326 46 C354 48, 378 68, 394 98 C402 142, 402 200, 396 244 C360 258, 320 262, 288 258 C254 190, 256 118, 274 66 Z',
      color: shade(NEON.body, -0.14),
      opacity: 1,
    },
  ];
}

export interface GlitchBand {
  y: number;
  h: number;
  /** Horizontal displacement, in viewBox units. Never near zero. */
  dx: number;
}

/**
 * Horizontal slices that jump sideways during the glitch beat.
 *
 * Seeded, so a given splash always breaks up the same way — this is a drawing,
 * not a particle system, and a test can only pin down the former. Offsets are
 * pushed away from zero because a band that barely moves is a rendering bug, not
 * a glitch.
 */
export function glitchBands(seed: number, count: number): GlitchBand[] {
  const rng = makeRng(seed);
  const out: GlitchBand[] = [];
  for (let i = 0; i < count; i++) {
    const h = rng.range(7, 26);
    const y = rng.range(0, BOAR_VIEWBOX.h - h);
    const mag = rng.range(6, 20);
    out.push({ y, h, dx: rng.chance(0.5) ? -mag : mag });
  }
  return out;
}

export interface Spark {
  x: number;
  y: number;
  r: number;
  /** Milliseconds after the spark beat starts. */
  delay: number;
  color: string;
}

/** How far a spark may travel from the point it is thrown off. */
export const SPARK_REACH = 40;

/**
 * Where sparks come off: the two tusk points. Exported so the tests can hold
 * them to the reach above rather than to a hand-copied bounding box, which stops
 * meaning anything the moment a tusk moves.
 */
export const SPARK_ORIGINS: ReadonlyArray<readonly [number, number]> = [
  [90, 76], [148, 140],
];

/**
 * Flecks thrown off the tusk tips. Clamped into the viewBox rather than
 * rejection-sampled: a spark is a dot a few px across and nudging one back
 * inside is invisible, where discarding it would thin the shower unevenly at
 * exactly the edge the tusks sit nearest.
 */
export function sparks(seed: number, count: number): Spark[] {
  const rng = makeRng(seed);
  const out: Spark[] = [];
  for (let i = 0; i < count; i++) {
    const [ox, oy] = SPARK_ORIGINS[i % SPARK_ORIGINS.length];
    const angle = rng.range(-Math.PI * 0.9, -Math.PI * 0.1);
    const dist = rng.range(6, SPARK_REACH);
    const r = rng.range(1.1, 2.9);
    out.push({
      x: clamp(ox + Math.cos(angle) * dist, r, BOAR_VIEWBOX.w - r),
      y: clamp(oy + Math.sin(angle) * dist, r, BOAR_VIEWBOX.h - r),
      r,
      delay: rng.range(0, 320),
      color: rng.chance(0.3) ? NEON.magenta : NEON.amber,
    });
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
