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
export const BOAR_VIEWBOX = { w: 500, h: 370 } as const;

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
   * Drawn *under* the body fills rather than on top of them.
   *
   * Every leg is. A leg drawn over the body carries its own closed top edge, and
   * that lid is what made the first version read as four boxes hung off the
   * belly rather than as legs — the body has to be the thing that hides where
   * they join. It also does the work of putting the far pair behind the near
   * one, since distance on a flat drawing is occlusion.
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
export const EYE_IDS = [
  'eyeNear', 'eyeNearIris', 'eyeNearGlint',
  'eyeFar', 'eyeFarIris', 'eyeFarGlint',
] as const;

// ---------------------------------------------------------------------------
// The drawing. Three-quarter view, camera off the front-left.
// ---------------------------------------------------------------------------

/**
 * The body, as one closed outline — ears included.
 *
 * The ears are points on this path rather than separate shapes because at this
 * angle they are part of the head's edge, and a triangle laid over a smooth
 * skull reads as a sticker.
 *
 * The bristled ridge is straight `L` segments over the rump only, where the rest
 * is curves. Two reasons: a spike drawn as a bezier softens into a bump, and
 * spiking the whole back — which an earlier pass did — turns the animal into a
 * hedgehog. Nearest the camera a boar's back is a smooth heavy shoulder.
 */
const BODY_D =
  'M48 168 C46 140, 52 112, 66 92 ' +
  'L62 46 L92 74 ' +                                  // near ear
  'C104 62, 116 54, 128 48 ' +
  'L146 20 L172 56 ' +                                // far ear
  'C196 52, 220 48, 244 46 ' +                        // smooth shoulder
  'L262 30 L276 58 L298 38 L312 64 L338 44 L352 72 ' +
  'L378 58 L390 86 L412 78 L420 106 L442 102 L446 130 ' +
  'L462 148 L444 168 L458 192 L436 210 L446 236 L420 252 ' +
  'C404 274, 372 288, 336 294 ' +
  'C286 302, 226 300, 172 292 ' +
  'C132 286, 100 272, 78 250 ' +
  'C60 232, 48 200, 48 168 Z';

const SILHOUETTE: ReadonlyArray<readonly [string, string]> = [
  ['body', BODY_D],
];

/**
 * Four legs, splayed rather than stacked in two pairs — at this angle the far
 * pair is inboard and shorter, and that offset is most of what sells the camera
 * position. The far pair also renders *under* the body fills: distance on a flat
 * drawing is occlusion, and a paler copy laid on top of the belly is a smudge.
 */
const LEGS_NEAR: ReadonlyArray<readonly [string, string]> = [
  ['legFrontNear', 'M85 254 C82 276, 84 298, 88 312 C96 318, 108 318, 116 312 C119 296, 118 274, 116 252 Z'],
  ['legHindNear', 'M333 266 C330 286, 332 304, 336 318 C344 324, 356 324, 364 318 C367 302, 366 284, 364 262 Z'],
];

const LEGS_FAR: ReadonlyArray<readonly [string, string]> = [
  ['legFrontFar', 'M141 266 C139 284, 141 298, 145 308 C152 313, 162 313, 169 308 C172 296, 171 282, 169 262 Z'],
  ['legHindFar', 'M263 272 C261 290, 263 302, 267 312 C274 317, 284 317, 291 312 C294 300, 293 286, 291 268 Z'],
];

/**
 * Hooves. The notch is cut into the path with two `L` segments rather than drawn
 * as a line across a solid block — cloven is a property of the silhouette, and a
 * scratch on a rectangle reads as a scratch.
 */
const HOOVES_NEAR: ReadonlyArray<readonly [string, string]> = [
  ['hoofFrontNear', 'M86 296 C96 301, 108 301, 117 296 C118 306, 117 314, 115 320 L102 313 L90 320 C87 313, 85 305, 86 296 Z'],
  ['hoofHindNear', 'M334 302 C344 307, 356 307, 365 302 C366 312, 365 320, 363 326 L350 319 L338 326 C335 319, 333 311, 334 302 Z'],
];

const HOOVES_FAR: ReadonlyArray<readonly [string, string]> = [
  ['hoofFrontFar', 'M142 292 C151 297, 161 297, 170 292 C171 301, 170 308, 168 313 L156 307 L145 313 C142 307, 141 300, 142 292 Z'],
  ['hoofHindFar', 'M264 296 C273 301, 283 301, 292 296 C293 305, 292 312, 290 317 L278 311 L267 317 C264 311, 263 304, 264 296 Z'],
];

/**
 * The snout, seen three-quarters on: a broad pale patch on the face with two
 * nostrils in it, not the disc-in-silhouette a side view gives. Along with the
 * second eye it is what places the camera.
 */
const SNOUT: ReadonlyArray<readonly [string, string]> = [
  ['snout', 'M84 188 C84 169, 102 157, 124 157 C146 157, 164 169, 164 188 C164 207, 146 219, 124 219 C102 219, 84 207, 84 188 Z'],
  ['nostrilNear', 'M112 176 C116 176, 119 181, 119 188 C119 195, 116 200, 112 200 C108 200, 105 195, 105 188 C105 181, 108 176, 112 176 Z'],
  ['nostrilFar', 'M137 176 C141 176, 144 181, 144 188 C144 195, 141 200, 137 200 C133 200, 130 195, 130 188 C130 181, 133 176, 137 176 Z'],
];

/** Coarse hair over the shoulder and flank, and the crease behind the head. */
const INTERIOR: ReadonlyArray<readonly [string, string]> = [
  ['flank1', 'M238 88 C258 80, 272 74, 278 62'],
  ['flank2', 'M262 100 C288 94, 312 92, 332 94'],
  ['flank3', 'M276 128 C302 122, 328 120, 350 122'],
  ['flank4', 'M290 162 C314 156, 338 154, 358 156'],
  ['flank5', 'M300 196 C322 192, 344 190, 362 192'],
];

const DETAIL: ReadonlyArray<readonly [string, string]> = [
  ['mouth', 'M100 224 C112 231, 136 231, 150 224'],
];

/**
 * The tusks flank the snout, one each side, as they do at this angle — and the
 * near one is markedly the bigger. They used to be near-identical crescents
 * overlapping each other, which reads as one thick tusk badly drawn rather than
 * as two at different distances.
 *
 * Tapered crescents rather than strokes: a tusk has a thick root and a point,
 * and a constant-width line reads as a whisker.
 */
const TUSK_NEAR: ReadonlyArray<readonly [string, string]> = [
  ['tuskNear', 'M88 204 C74 206, 60 200, 50 188 C42 178, 38 164, 38 150 C46 158, 50 172, 60 184 C70 196, 80 202, 92 200 Z'],
];

const TUSK_FAR: ReadonlyArray<readonly [string, string]> = [
  ['tuskFar', 'M168 210 C178 212, 188 207, 194 197 C199 189, 201 180, 202 172 C196 178, 193 187, 187 194 C180 202, 174 206, 166 205 Z'],
];

/**
 * Both eyes, each built from an outline, an iris and a glint rather than as one
 * filled oval. They light on ONE beat: an iris arriving before its own pupil, or
 * one eye before the other, is a drawing assembling itself rather than an animal
 * opening its eyes.
 *
 * The glints do most of the work — they are the only pure-white spots on the
 * boar, and they are what make the eyes wet instead of flat.
 */
const EYES: ReadonlyArray<readonly [string, string]> = [
  ['eyeNear', 'M86 132 C93 132, 98 138, 98 146 C98 154, 93 160, 86 160 C79 160, 74 154, 74 146 C74 138, 79 132, 86 132 Z'],
  ['eyeNearIris', 'M86 137 C91 137, 94 141, 94 146 C94 151, 91 155, 86 155 C81 155, 78 151, 78 146 C78 141, 81 137, 86 137 Z'],
  ['eyeNearGlint', 'M82 140 C84 140, 85 141, 85 143 C85 144, 84 145, 82 145 C81 145, 80 144, 80 143 C80 141, 81 140, 82 140 Z'],
  ['eyeFar', 'M186 130 C192 130, 197 136, 197 144 C197 152, 192 158, 186 158 C180 158, 175 152, 175 144 C175 136, 180 130, 186 130 Z'],
  ['eyeFarIris', 'M186 135 C190 135, 193 139, 193 144 C193 149, 190 153, 186 153 C182 153, 179 149, 179 144 C179 139, 182 135, 186 135 Z'],
  ['eyeFarGlint', 'M182 138 C184 138, 185 139, 185 141 C185 142, 184 143, 182 143 C181 143, 180 142, 180 141 C180 139, 181 138, 182 138 Z'],
];

/**
 * The bristle bed, walked so the outward normal points away from the animal —
 * see `alongSpine`. It follows the tips of the rump spikes, so the neon catches
 * on the ridge the outline already has rather than inventing a second one.
 */
const MANE_SPINE: ReadonlyArray<readonly [number, number]> = [
  [262, 30], [298, 38], [338, 44], [378, 58], [412, 78], [442, 102],
];

const BRISTLE_COUNT = 11;

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
 * Every stroke of the wireframe, in the order it is DRAWN ON — which is not the
 * order it is painted in.
 *
 * The reveal is: the body, then the legs it stands on, then its face, then the
 * tusks, and the eyes last of all. Paint order is a separate question answered
 * by `behind`, and Splash.tsx regroups on that flag before rendering. Emitting
 * these in paint order — which an earlier version did, because the legs go
 * underneath — opened the splash on four disembodied legs with no animal.
 *
 * The order is asserted in the tests because reordering the arrays above is a
 * one-line change that would silently ruin the only timing the splash has.
 */
export function boarStrokes(): BoarStroke[] {
  const far = (strokes: BoarStroke[]) => strokes.map(t => ({ ...t, behind: true }));
  const hoof = shade(NEON.body, -0.55);
  const eyes = seg(EYES, 'detail', NEON.ink, 1.6).map(e =>
    e.id.endsWith('Iris')
      ? { ...e, color: NEON.amber, width: 1.2, fill: NEON.amber }
      : e.id.endsWith('Glint')
        ? { ...e, color: NEON.ink, width: 0.6, fill: NEON.ink }
        : { ...e, fill: shade(NEON.body, -0.62) });

  return [
    // The body first: it is the thing being revealed, and the legs belong to it.
    ...seg(SILHOUETTE, 'silhouette', NEON.ink, 3.2),

    // Then the legs. Far pair before near, so within the under-body group the
    // near pair paints over it.
    ...far(seg(LEGS_FAR, 'silhouette', shade(NEON.ink, -0.4), 2.2)
      .map(l => ({ ...l, fill: shade(NEON.body, -0.22) }))),
    ...far(seg(HOOVES_FAR, 'detail', shade(NEON.ink, -0.5), 1.5)
      .map(h => ({ ...h, fill: shade(hoof, -0.15) }))),
    ...far(seg(LEGS_NEAR, 'silhouette', NEON.ink, 2.2).map(l => ({ ...l, fill: NEON.body }))),
    ...far(seg(HOOVES_NEAR, 'detail', NEON.ink, 1.7).map(h => ({ ...h, fill: hoof }))),

    ...seg(INTERIOR, 'interior', NEON.cyan, 2),
    ...seg(SNOUT, 'detail', NEON.ink, 2)
      .map(d => ({ ...d, fill: d.id === 'snout' ? shade(NEON.body, 0.2) : shade(NEON.body, -0.6) })),
    ...seg(DETAIL, 'detail', NEON.cyan, 1.8),
    ...maneBristles(),

    // The far tusk is drawn on top, small and dim, because the head covers every
    // position it could occupy — here distance is size and tone, not occlusion.
    ...seg(TUSK_FAR, 'tusk', shade(NEON.bone, -0.12), 1.9)
      .map(t => ({ ...t, fill: shade(NEON.bone, -0.22) })),
    ...seg(TUSK_NEAR, 'tusk', NEON.ink, 2.4).map(t => ({ ...t, fill: NEON.bone })),

    ...eyes,
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
      d: 'M48 168 C46 140, 52 112, 66 92 L62 46 L92 74 C104 62, 116 54, 128 48 L146 20 L172 56 C190 54, 206 52, 222 50 C234 120, 236 210, 224 280 C186 296, 140 288, 104 272 C74 258, 50 212, 48 168 Z',
      color: shade(NEON.body, 0.07),
      opacity: 1,
    },
    {
      id: 'rumpFacet',
      d: 'M338 44 L352 72 L378 58 L390 86 L412 78 L420 106 L442 102 L446 130 L462 148 L444 168 L458 192 L436 210 L446 236 L420 252 C404 274, 372 288, 336 294 C328 295, 320 296, 312 296 C322 216, 322 120, 338 44 Z',
      color: shade(NEON.body, -0.17),
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
  [40, 152], [202, 174],
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
