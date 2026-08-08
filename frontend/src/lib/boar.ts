// The launch splash: a boar's head seen head-on, drawn as a neon wireframe.
//
// Geometry only — no DOM, no Math.random, no anime.js. Same split the landscape
// uses (see lib/landscape/shapes.ts): the numbers live here where a test can
// reach them, and Splash.tsx is a dumb projection of what this file returns.
//
// It faces the viewer, which changes how the file is written. A frontal face is
// symmetric, and hand-authoring both halves guarantees they drift — a tusk two
// pixels longer on one side is invisible in the source and glaring on screen.
// So only the left half is written down and `mirrorPath` produces the right,
// which is also why every path is absolute M/C/Z: that is what lets the mirror
// (and the containment tests) treat the numbers as coordinate pairs.

import { makeRng, hashText } from './landscape/rng';

/**
 * The coordinate space every path below is expressed in.
 *
 * Wider and taller than the drawing needs: the neon filter blurs well outside
 * the strokes, and the SVG root clips at the viewBox, so a snug box shears the
 * glow off flat along an edge and the tusks look cut.
 */
export const BOAR_VIEWBOX = { w: 460, h: 400 } as const;

/** The mirror line. Everything symmetric is reflected about it. */
export const CENTRE_X = 230;

/**
 * The splash's own colours, deliberately not the `--accent` / `--surface` CSS
 * variables. Same reasoning as landscape/palette.ts: this is a picture with its
 * own light rather than a chrome surface, and tying it to the theme would flatten
 * it to the colour of a button.
 */
export const NEON = {
  ink: '#f2fbff',
  bone: '#d3e7f4',
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
  drawStagger: 10,
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
  /** Closed shapes get a faint wash; open contour lines must not. */
  closed: boolean;
  /**
   * Set only on the tusks. They are the one part of the animal that is a solid
   * object rather than a contour, and drawn as outlines they came out as loops
   * of wire hanging off the jaw.
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
 * Both eyes, by id — they light on their own beat and have to do it together.
 * A face that switches one eye on first is winking, not waking up.
 */
export const EYE_IDS = ['eye', 'eye-r'] as const;

/** Suffix `mirrorPath` gives the reflected copy of a left-half stroke. */
const MIRROR_SUFFIX = '-r';

/**
 * Reflects an absolute M/C/Z path about `cx`.
 *
 * Only x is touched, and only the even-indexed numbers are x — which holds
 * because M and C both take coordinate pairs and Z takes none. Any other command
 * would put an odd count in the stream and silently reflect y values into x, so
 * the "absolute M/C/Z only" rule is enforced by a test rather than left as a
 * comment.
 */
export function mirrorPath(d: string, cx: number = CENTRE_X): string {
  let index = 0;
  return d.replace(/-?\d+(?:\.\d+)?/g, match => {
    const isX = index++ % 2 === 0;
    if (!isX) return match;
    // Formatted to the same number of decimals as the source token, which both
    // trims the float noise `2*cx - n` leaves behind and makes the mirror a true
    // involution: `String(Math.round(...))` turned the bristles' "171.0" into
    // "171", so mirroring twice did not give back the path it started from.
    const dot = match.indexOf('.');
    return (2 * cx - Number(match)).toFixed(dot === -1 ? 0 : match.length - dot - 1);
  });
}

// ---------------------------------------------------------------------------
// The drawing. Left half only, unless marked on-axis.
//
// Head-on, a boar is a SHIELD, not a disc: widest across the brow and the ears,
// narrowing all the way down to a snout that hangs below the jawline. The first
// two frontal passes were built on a round skull with small upright ears, and
// both read unmistakably as a cat — a circle with triangles on top is that
// animal whatever else you draw inside it.
//
// The three things that carry the read, in order of how much they matter:
//   1. the outline tapering downward rather than closing into a circle,
//   2. a snout disc big enough to be the animal's main feature, hanging below
//      the jaw rather than sitting on the face,
//   3. tusks that come out of a MOUTH — floating beside the head they are horns.
// ---------------------------------------------------------------------------

/** Skull and ears — the outer edge of the animal. */
const SILHOUETTE_HALF: ReadonlyArray<readonly [string, string]> = [
  ['skull', 'M230 60 C204 56, 182 58, 166 66 C146 76, 130 88, 124 104 C122 144, 130 212, 148 268 C158 298, 174 316, 194 326'],
  // Big, leaf-shaped, and swept out and back from the upper corner of the
  // skull. Small upright triangles on top of the head are cat ears, and they
  // were the single loudest wrong signal in the version before this one.
  ['ear', 'M170 78 C150 62, 126 52, 106 52 C108 76, 126 98, 152 102 Z'],
];

/** Creases: brow, the muzzle hanging down the middle, the mouth under it. */
const INTERIOR_HALF: ReadonlyArray<readonly [string, string]> = [
  // Heavy and low, so the eye sits under it rather than on an open face.
  ['brow', 'M126 150 C146 134, 172 130, 194 136'],
  ['earInner', 'M160 80 C144 68, 128 60, 114 58'],
  // The muzzle hangs past the jaw. Head-on, snout length is the whole
  // difference between a boar and anything else with a wedge-shaped skull.
  ['muzzleEdge', 'M188 176 C176 214, 170 254, 172 300'],
  ['cheekCrease', 'M128 196 C148 220, 164 252, 170 290'],
  // The mouth the tusks come out of. Without it they are two horns leaning
  // against the head, which is exactly how they read before it was added.
  ['mouth', 'M196 346 C210 354, 221 357, 230 357'],
];

/** On-axis: symmetric in itself, so it is written once and never mirrored. */
const INTERIOR_AXIS: ReadonlyArray<readonly [string, string]> = [
  ['muzzleRidge', 'M230 178 C230 220, 230 262, 230 300'],
  // Deliberately huge, and hanging below the jaw. A boar's nose disc is the
  // animal's main feature; drawn politely small it becomes a nose on a face.
  ['snout', 'M156 312 C156 288, 189 272, 230 272 C271 272, 304 288, 304 312 C304 336, 271 352, 230 352 C189 352, 156 336, 156 312 Z'],
];

const DETAIL_HALF: ReadonlyArray<readonly [string, string]> = [
  ['nostril', 'M182 300 C182 289, 194 283, 203 289 C210 294, 208 306, 198 310 C188 314, 182 308, 182 300 Z'],
  ['iris', 'M147 162 C153 159, 160 161, 161 166 C157 171, 149 170, 147 162 Z'],
  // Two bands across each tusk. Placed by eye against the crescent rather than
  // derived from it: the tusk is a hand-drawn bezier, and a band computed from
  // a curve nobody sampled would be no more accurate and much harder to nudge.
  ['bandRoot', 'M148 352 C149 346, 150 342, 151 336'],
  ['bandMid', 'M104 286 C110 288, 116 289, 122 290'],
];

const DETAIL_AXIS: ReadonlyArray<readonly [string, string]> = [
  // The chevron on the forehead. It is the reference's tilaka and it also reads
  // as a HUD marker, which is the only reason it survives the change of idiom.
  ['chevron', 'M214 76 C220 98, 224 110, 230 126 C236 110, 240 98, 246 76'],
  // The ring sits in the middle of the snout disc, not hanging below it — a
  // ring under the jaw reads as a collar.
  ['ringOuter', 'M230 294 C243 294, 254 305, 254 318 C254 331, 243 342, 230 342 C217 342, 206 331, 206 318 C206 305, 217 294, 230 294 Z'],
  ['ringInner', 'M230 302 C239 302, 246 309, 246 318 C246 327, 239 334, 230 334 C221 334, 214 327, 214 318 C214 309, 221 302, 230 302 Z'],
];

/**
 * The tusk. It roots at the corner of the mouth, sweeps down and out, and comes
 * back up across the cheek with the tip hooking inward — so the pair frames the
 * face and, crucially, is attached to it.
 *
 * A tapered crescent rather than a stroke: a tusk is a solid object, and a
 * constant-width line reads as a whisker.
 */
const TUSK_HALF: ReadonlyArray<readonly [string, string]> = [
  ['tusk', 'M192 348 C160 358, 124 346, 108 308 C94 274, 98 232, 116 202 C120 228, 114 258, 126 288 C140 320, 168 342, 196 340 Z'],
];

/** Each eye, addressable so the pair can be lit on its own beat. */
const EYE_HALF: ReadonlyArray<readonly [string, string]> = [
  // Small and deep-set under the brow. The wide almond of the previous pass was
  // half of why that face read as a cat.
  ['eye', 'M132 166 C142 156, 160 154, 172 162 C162 172, 142 175, 132 166 Z'],
];

/**
 * Bristle beds. Each is a polyline the bristles stand on, walked so that the
 * outward normal points away from the animal — see `alongSpine`.
 */
const CREST_SPINE: ReadonlyArray<readonly [number, number]> = [
  [178, 64], [200, 58], [216, 55], [230, 54],
];
// Down the jowl rather than out from the cheek. Bristles standing straight out
// sideways are whiskers, and whiskers are a cat.
const CHEEK_SPINE: ReadonlyArray<readonly [number, number]> = [
  [148, 268], [130, 224], [124, 180],
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * A point and outward normal at fraction `t` along a spine.
 *
 * Straight-line interpolation over the control points, not a curve: a spine is
 * only ever used to stand short bristles on, so the few px a bezier would move a
 * root by is invisible, and the polyline gives an exact normal for free. Which
 * side "outward" is falls out of the winding, so each spine above is written in
 * the direction that puts it on the outside.
 */
function alongSpine(
  spine: ReadonlyArray<readonly [number, number]>,
  t: number,
): { x: number; y: number; nx: number; ny: number } {
  const span = spine.length - 1;
  const scaled = Math.min(t, 0.999999) * span;
  const i = Math.floor(scaled);
  const f = scaled - i;
  const [ax, ay] = spine[i];
  const [bx, by] = spine[i + 1];
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

interface BristleBed {
  id: string;
  spine: ReadonlyArray<readonly [number, number]>;
  count: number;
  minLen: number;
  maxLen: number;
}

const BRISTLE_BEDS: readonly BristleBed[] = [
  { id: 'crest', spine: CREST_SPINE, count: 6, minLen: 16, maxLen: 28 },
  { id: 'cheek', spine: CHEEK_SPINE, count: 5, minLen: 10, maxLen: 18 },
];

function bristles(bed: BristleBed): BoarStroke[] {
  const rng = makeRng(hashText(`yv-boar-${bed.id}`));
  const out: BoarStroke[] = [];
  for (let i = 0; i < bed.count; i++) {
    const t = (i + 0.5) / bed.count;
    const { x, y, nx, ny } = alongSpine(bed.spine, t);
    // Longest in the middle of the bed — one length all the way along reads as
    // a comb rather than as fur.
    const taper = 0.55 + 0.45 * Math.sin(t * Math.PI);
    const len = rng.range(bed.minLen, bed.maxLen) * taper;
    const lean = rng.range(0.15, 0.5);
    const tipX = x + nx * len - lean * len * ny;
    const tipY = y + ny * len + lean * len * nx;
    const f = (n: number) => n.toFixed(1);
    out.push({
      id: `${bed.id}${i}`,
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

/** A stroke and its reflection, adjacent, so the pair draws on together. */
function paired(strokes: BoarStroke[]): BoarStroke[] {
  return strokes.flatMap(s => [
    s,
    { ...s, id: s.id + MIRROR_SUFFIX, d: mirrorPath(s.d) },
  ]);
}

/**
 * Every stroke of the wireframe, in the order it is drawn on.
 *
 * The order is the reveal: skull and ears, then the face, then the muzzle and
 * snout, then the tusks that frame the whole thing, and the eyes last of all.
 * It is asserted in the tests because reordering the arrays above is a one-line
 * change that would silently ruin the only timing the splash has.
 *
 * Each half-stroke is emitted next to its mirror rather than in a second pass,
 * so the two sides of the face arrive together. Drawn left-half-first the animal
 * would build itself lopsided for most of a second, which reads as a bug.
 */
export function boarStrokes(): BoarStroke[] {
  return [
    ...paired(seg(SILHOUETTE_HALF, 'silhouette', NEON.ink, 3.2)),
    ...paired(bristles(BRISTLE_BEDS[0])),
    ...paired(bristles(BRISTLE_BEDS[1])),
    ...paired(seg(INTERIOR_HALF, 'interior', NEON.cyan, 2)),
    ...seg(INTERIOR_AXIS, 'interior', NEON.cyan, 2),
    ...paired(seg(DETAIL_HALF, 'detail', NEON.cyan, 1.6)),
    ...seg(DETAIL_AXIS, 'detail', NEON.amber, 2),
    ...paired(seg(TUSK_HALF, 'tusk', NEON.ink, 2.4).map(t => ({ ...t, fill: NEON.bone }))),
    ...paired(seg(EYE_HALF, 'detail', NEON.magenta, 2.2)),
  ];
}

/**
 * Flat facets washed in behind the strokes. Without them the boar is pure
 * outline and reads as a diagram; a handful of low-opacity planes give it mass
 * without turning it into a filled illustration.
 *
 * The face and muzzle are written closed across the centre line rather than
 * mirrored — a wash mirrored into two halves shows the seam between them, which
 * is the exact defect the profile drawing had between its cheek and its hump.
 */
export function boarFacets(): BoarFacet[] {
  const ear = 'M170 78 C150 62, 126 52, 106 52 C108 76, 126 98, 152 102 Z';
  return [
    {
      id: 'faceFacet',
      d: 'M230 60 C204 56, 182 58, 166 66 C146 76, 130 88, 124 104 C122 144, 130 212, 148 268 C158 298, 174 316, 194 326 C212 332, 248 332, 266 326 C286 316, 302 298, 312 268 C330 212, 338 144, 336 104 C330 88, 314 76, 294 66 C278 58, 256 56, 230 60 Z',
      color: NEON.cyan,
      opacity: 0.11,
    },
    {
      id: 'muzzleFacet',
      d: 'M188 176 C176 214, 170 254, 172 300 C194 310, 266 310, 288 300 C290 254, 284 214, 272 176 C252 166, 208 166, 188 176 Z',
      color: NEON.violet,
      opacity: 0.12,
    },
    { id: 'earFacet', d: ear, color: NEON.magenta, opacity: 0.16 },
    { id: 'earFacet-r', d: mirrorPath(ear), color: NEON.magenta, opacity: 0.16 },
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
 * Where sparks come off: the two tusk points, and the ring under the snout.
 * Exported so the tests can hold them to the reach above rather than to a
 * hand-copied bounding box that stops meaning anything the moment a tusk moves.
 */
export const SPARK_ORIGINS: ReadonlyArray<readonly [number, number]> = [
  [116, 204], [344, 204], [230, 318],
];

/**
 * Flecks thrown off the tusk tips. Clamped into the viewBox rather than
 * rejection-sampled: a spark is a dot a few px across and nudging one back
 * inside is invisible, where discarding it would thin the shower unevenly at
 * exactly the edges the tusks sit nearest.
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
