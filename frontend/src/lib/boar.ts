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
export const BOAR_VIEWBOX = { w: 460, h: 360 } as const;

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
 * Every part of the eye, by id. They light on one beat: an iris that arrives
 * before its own pupil is a drawing assembling itself, not an eye opening.
 */
export const EYE_IDS = ['eye', 'eyeIris', 'eyePupil', 'eyeGlint'] as const;

// ---------------------------------------------------------------------------
// The drawing. Facing left.
// ---------------------------------------------------------------------------

/**
 * The body, as one closed outline.
 *
 * The back is a run of straight `L` segments rather than curves: the bristled
 * ridge is the animal's most recognisable edge from the side, and a spike drawn
 * as a bezier softens into a bump. Everything below the shoulder is curved,
 * because a boar is round everywhere the bristles are not.
 */
const BODY_D =
  'M56 148 C66 128, 82 116, 100 108 ' +
  'L116 92 L128 104 L146 78 L160 96 L184 66 L200 86 L228 60 L244 84 ' +
  'L274 62 L290 86 L318 70 L332 96 L356 88 L366 112 L388 110 L398 132 ' +
  'C412 152, 418 182, 414 208 C410 236, 396 254, 376 262 ' +
  'C340 272, 300 274, 260 272 C220 270, 180 268, 150 262 ' +
  'C126 256, 108 240, 100 218 C92 200, 84 186, 70 178 ' +
  'C60 172, 52 160, 56 148 Z';

const SILHOUETTE: ReadonlyArray<readonly [string, string]> = [
  ['body', BODY_D],
];

/**
 * Legs, near pair and far pair.
 *
 * The far pair is drawn *behind* the body and set inboard, which is the whole
 * trick: distance on a flat drawing is occlusion. Four legs side by side on the
 * same plane read as a centipede, and a paler copy laid on top of the belly
 * reads as a smudge.
 */
const LEGS_NEAR: ReadonlyArray<readonly [string, string]> = [
  ['legFrontNear', 'M128 252 C126 272, 128 288, 131 300 C140 304, 150 304, 158 300 C160 286, 160 268, 158 250 Z'],
  ['legHindNear', 'M318 254 C316 274, 318 290, 321 302 C330 306, 340 306, 348 302 C350 288, 350 268, 348 252 Z'],
];

const LEGS_FAR: ReadonlyArray<readonly [string, string]> = [
  ['legFrontFar', 'M166 250 C164 268, 166 284, 169 296 C177 300, 186 300, 193 296 C195 282, 195 264, 193 248 Z'],
  ['legHindFar', 'M356 250 C354 268, 356 284, 359 296 C367 300, 376 300, 383 296 C385 282, 385 264, 383 248 Z'],
];

/** Hooves. Cloven, which is one more thing the animal cannot be mistaken for. */
const HOOVES_NEAR: ReadonlyArray<readonly [string, string]> = [
  ['hoofFrontNear', 'M130 288 C140 292, 150 292, 159 288 C160 296, 159 304, 157 309 C148 312, 140 312, 132 309 C130 302, 129 294, 130 288 Z'],
  ['hoofHindNear', 'M320 290 C330 294, 340 294, 349 290 C350 298, 349 306, 347 311 C338 314, 330 314, 322 311 C320 304, 319 296, 320 290 Z'],
];

const HOOVES_FAR: ReadonlyArray<readonly [string, string]> = [
  ['hoofFrontFar', 'M168 284 C177 288, 186 288, 194 284 C195 292, 194 299, 192 304 C184 307, 176 307, 169 304 C167 297, 167 290, 168 284 Z'],
  ['hoofHindFar', 'M358 284 C367 288, 376 288, 384 284 C385 292, 384 299, 382 304 C374 307, 366 307, 359 304 C357 297, 357 290, 358 284 Z'],
];

/** Creases, the ear, and the streaks of coarser hair along the flank. */
const EAR: ReadonlyArray<readonly [string, string]> = [
  ['ear', 'M92 112 C94 92, 101 80, 111 77 C118 86, 118 102, 111 114 Z'],
];

const INTERIOR: ReadonlyArray<readonly [string, string]> = [
  ['shoulderCrease', 'M150 118 C166 146, 174 182, 170 218'],
  ['flank1', 'M206 108 C228 116, 248 126, 262 140'],
  ['flank2', 'M238 132 C260 140, 282 150, 298 162'],
  ['flank3', 'M232 172 C256 178, 280 184, 298 192'],
  ['flank4', 'M228 206 C252 210, 274 214, 292 218'],
];

/**
 * The snout disc, seen side-on: a broad oval carried out in front of the face,
 * with two nostrils in it. Along with the legs it is what makes the silhouette
 * unambiguous — every other animal this drawing has accidentally been had a
 * snout that tapered into the head instead of ending in a flat disc.
 */
const SNOUT: ReadonlyArray<readonly [string, string]> = [
  ['snout', 'M42 160 C42 149, 52 142, 64 142 C76 142, 86 149, 86 160 C86 171, 76 178, 64 178 C52 178, 42 171, 42 160 Z'],
  ['nostrilNear', 'M55 152 C58 152, 61 155, 61 160 C61 165, 58 168, 55 168 C52 168, 49 165, 49 160 C49 155, 52 152, 55 152 Z'],
  ['nostrilFar', 'M72 152 C75 152, 78 155, 78 160 C78 165, 75 168, 72 168 C69 168, 66 165, 66 160 C66 155, 69 152, 72 152 Z'],
];

const DETAIL: ReadonlyArray<readonly [string, string]> = [
  ['mouth', 'M86 176 C96 184, 108 188, 120 189'],
];

/**
 * The tusks: a big near one and a small far one, set well apart.
 *
 * Near-identical crescents overlapping each other read as one thick tusk badly
 * drawn. In profile the far tusk is foreshortened, rooted further back along the
 * jaw and partly hidden by the head — so it is smaller, dimmer, and rendered
 * BEHIND the body, for the same reason the far legs are.
 *
 * Tapered crescents rather than strokes: a tusk has a thick root and a point,
 * and a constant-width line reads as a whisker. Their tips finish *above* the
 * muzzle line — kept politely below they read as teeth.
 */
const TUSK_NEAR: ReadonlyArray<readonly [string, string]> = [
  ['tuskNear', 'M66 198 C54 196, 42 188, 32 174 C24 164, 20 154, 20 146 C28 152, 32 162, 40 172 C48 182, 58 190, 70 192 Z'],
];

const TUSK_FAR: ReadonlyArray<readonly [string, string]> = [
  ['tuskFar', 'M104 196 C98 194, 92 188, 89 178 C86 170, 85 162, 86 154 C91 161, 92 170, 96 178 C100 186, 104 191, 109 192 Z'],
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
  ['eye', 'M100 140 C100 132, 105 126, 111 126 C117 126, 122 132, 122 140 C122 148, 117 154, 111 154 C105 154, 100 148, 100 140 Z'],
  ['eyeIris', 'M111 131 C116 131, 119 135, 119 140 C119 145, 116 149, 111 149 C106 149, 103 145, 103 140 C103 135, 106 131, 111 131 Z'],
  ['eyePupil', 'M111 135 C114 135, 116 137, 116 140 C116 143, 114 145, 111 145 C108 145, 106 143, 106 140 C106 137, 108 135, 111 135 Z'],
  ['eyeGlint', 'M107 134 C109 134, 110 135, 110 137 C110 138, 109 139, 107 139 C106 139, 105 138, 105 137 C105 135, 106 134, 107 134 Z'],
];

/**
 * The bristle bed, walked so the outward normal points away from the animal —
 * see `alongSpine`. It follows the tips of the dorsal spikes, so the neon
 * catches on the ridge that already exists in the outline rather than inventing
 * a second one beside it.
 */
const MANE_SPINE: ReadonlyArray<readonly [number, number]> = [
  [116, 92], [146, 78], [184, 66], [228, 60], [274, 62], [318, 70], [356, 88],
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
    const len = rng.range(9, 18) * taper;
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
 * The order is the reveal: the far side of the animal first (it is underneath
 * everything), then the body, then its legs, then the detail, and the eye last.
 * It is asserted in the tests because reordering the arrays above is a one-line
 * change that would silently ruin the only timing the splash has.
 */
export function boarStrokes(): BoarStroke[] {
  const far = (strokes: BoarStroke[]) => strokes.map(t => ({ ...t, behind: true }));
  const hoof = shade(NEON.body, -0.55);
  const [eye, iris, pupil, glint] = seg(EYES, 'detail', NEON.ink, 1.6);

  return [
    // The far side, drawn first because it is drawn under the body.
    ...far(seg(LEGS_FAR, 'silhouette', shade(NEON.ink, -0.4), 2.2)
      .map(l => ({ ...l, fill: shade(NEON.body, -0.22) }))),
    ...far(seg(HOOVES_FAR, 'detail', shade(NEON.ink, -0.5), 1.6)
      .map(h => ({ ...h, fill: shade(hoof, -0.15) }))),

    ...seg(SILHOUETTE, 'silhouette', NEON.ink, 3.2),
    ...seg(LEGS_NEAR, 'silhouette', NEON.ink, 2.6).map(l => ({ ...l, fill: NEON.body })),
    ...seg(HOOVES_NEAR, 'detail', NEON.ink, 1.8).map(h => ({ ...h, fill: hoof })),
    ...seg(EAR, 'silhouette', NEON.ink, 2.2).map(e => ({ ...e, fill: shade(NEON.body, -0.3) })),

    ...seg(INTERIOR, 'interior', NEON.cyan, 2),
    ...seg(SNOUT, 'detail', NEON.ink, 2)
      .map(d => ({ ...d, fill: d.id === 'snout' ? shade(NEON.body, 0.18) : shade(NEON.body, -0.55) })),
    ...seg(DETAIL, 'detail', NEON.cyan, 1.8),
    ...maneBristles(),
    // The far tusk is drawn on top, small and dim, because the head covers every
    // position it could occupy — here distance is size and tone, not occlusion.
    ...seg(TUSK_FAR, 'tusk', shade(NEON.bone, -0.3), 1.8)
      .map(t => ({ ...t, fill: shade(NEON.bone, -0.4) })),
    ...seg(TUSK_NEAR, 'tusk', NEON.ink, 2.4).map(t => ({ ...t, fill: NEON.bone })),

    { ...eye, fill: shade(NEON.body, -0.5) },
    { ...iris, color: NEON.amber, width: 1.2, fill: NEON.amber },
    { ...pupil, color: shade(NEON.body, -0.75), width: 0.8, fill: shade(NEON.body, -0.75) },
    { ...glint, color: NEON.ink, width: 0.6, fill: NEON.ink },
  ];
}

/**
 * The flat tone planes behind the strokes, in the animal's own colour.
 *
 * Opaque, and all shades of one hue. They used to be low-opacity cyan and violet
 * washes over the backdrop, which is why the boar came out mauve — the chroma
 * ghosts tint whatever they copy, and copying a translucent body tinted the
 * whole animal rather than just its outline.
 *
 * Written to **overlap** along every shared edge: two fills that merely meet
 * leave a hairline of backdrop between them, and at this contrast that hairline
 * reads as a seam cut through the animal.
 */
export function boarFacets(): BoarFacet[] {
  return [
    { id: 'bodyFacet', d: BODY_D, color: NEON.body, opacity: 1 },
    {
      id: 'headFacet',
      d: 'M56 148 C66 128, 82 116, 100 108 L116 92 L128 104 L146 78 L160 96 C170 140, 176 190, 170 242 C142 246, 116 238, 100 218 C92 200, 84 186, 70 178 C60 172, 52 160, 56 148 Z',
      color: shade(NEON.body, 0.1),
      opacity: 1,
    },
    {
      id: 'rumpFacet',
      d: 'M318 70 L332 96 L356 88 L366 112 L388 110 L398 132 C412 152, 418 182, 414 208 C410 236, 396 254, 376 262 C352 268, 330 271, 306 272 C296 208, 300 138, 318 70 Z',
      color: shade(NEON.body, -0.16),
      opacity: 1,
    },
    { id: 'earFacet', d: 'M92 112 C94 92, 101 80, 111 77 C118 86, 118 102, 111 114 Z', color: shade(NEON.body, -0.28), opacity: 1 },
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
  [22, 148], [88, 156],
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
