/**
 * Speech bubbles, as drawable geometry.
 *
 * Eight shapes — a plain oval through to a comic-book starburst — so the drone
 * does not say everything in the same box. Which one a message gets is seeded,
 * not random: a bubble that reshaped itself on every re-render would be
 * unreadable, and a seeded pick is reproducible in a test.
 *
 * Everything here is a pure function of a string and a box. Nothing knows about
 * drones, dinosaurs or the map, which is what lets `droneInsets` size flight
 * bounds from the same object the component draws.
 *
 * The shapes are built to fill an *outer* box and lay their text inside an inner
 * one. That distinction is the whole reason the spiky variants work: a starburst
 * spends a lot of its width on points that text cannot sit under, so it is given
 * a bigger outer box for the same string rather than a smaller typeface.
 */

import type { Pt } from './landscape/geometry';

export type BubbleKind =
  | 'oval'
  | 'burst'
  | 'banner'
  | 'square'
  | 'pill'
  | 'sketch'
  | 'cloud'
  | 'spike';

/** Every shape, in the order they are drawn in the reference sheet. */
export const BUBBLE_KINDS: readonly BubbleKind[] = [
  'oval',
  'burst',
  'banner',
  'square',
  'pill',
  'sketch',
  'cloud',
  'spike',
] as const;

/** Type size of a bubble's text, in world units. Matches .land-chat-text. */
export const CHAT_FONT = 12;

/**
 * Advance width of one character at CHAT_FONT.
 *
 * The box is sized from the string rather than measured, because it is drawn
 * inside an SVG viewBox scaled to the panel — getComputedTextLength needs a
 * live, laid-out element and would put the geometry somewhere no test can
 * reach. 0.6em is the advance of the monospace face the map labels already use,
 * so for that face this is exact rather than approximate.
 */
export const CHAT_CHAR_W = CHAT_FONT * 0.6;

/**
 * How much room each shape needs around its text.
 *
 * Not one padding for all of them: an ellipse loses its corners, a starburst
 * spends most of its outline on spikes, and a square loses almost nothing. Set
 * per shape so the text clears the outline in each, instead of padding
 * everything for the worst case and leaving the square looking empty.
 */
const SHAPE_PAD: Record<BubbleKind, Pt> = {
  oval: { x: 20, y: 11 },
  burst: { x: 30, y: 22 },
  banner: { x: 16, y: 7 },
  square: { x: 10, y: 7 },
  pill: { x: 15, y: 7 },
  sketch: { x: 13, y: 9 },
  cloud: { x: 18, y: 15 },
  spike: { x: 34, y: 26 },
};

/** How far a burst's lobes swell past the ellipse they sit on. */
const BURST_BULGE = 1.2;

/** The same, for the cloud's larger and lumpier bumps. */
const CLOUD_BULGE = 1.28;

/** Gap between the airframe and the bubble's near corner. */
const CHAT_GAP = 6;

export interface ChatBubble {
  kind: BubbleKind;
  /** The message, carried along so the drawing side needs nothing else. */
  text: string;
  /** Outer box, relative to whatever the bubble is anchored to. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The outline. */
  path: string;
  /** Tail back to the speaker, or '' for the shapes that have none. */
  tail: string;
  /**
   * Extra strokes drawn on top: the burst's radiating ticks and the sketch's
   * second pass. Separate from `path` because they are unfilled and open, and
   * folding them into one path would make the fill rule decide the result.
   */
  accents: string[];
  /** Text anchor: left-aligned, on the baseline. */
  textX: number;
  textY: number;
}

// --- path helpers ----------------------------------------------------------

const n = (v: number): string => v.toFixed(2);

function polygon(points: Pt[]): string {
  return `M ${points.map((p) => `${n(p.x)} ${n(p.y)}`).join(' L ')} Z`;
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  // Two arcs rather than <ellipse>, so every shape is one path and the caller
  // never has to branch on element type.
  return [
    `M ${n(cx - rx)} ${n(cy)}`,
    `A ${n(rx)} ${n(ry)} 0 0 1 ${n(cx + rx)} ${n(cy)}`,
    `A ${n(rx)} ${n(ry)} 0 0 1 ${n(cx - rx)} ${n(cy)}`,
    'Z',
  ].join(' ');
}

function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, w / 2, h / 2);
  return [
    `M ${n(x + radius)} ${n(y)}`,
    `H ${n(x + w - radius)}`,
    `A ${n(radius)} ${n(radius)} 0 0 1 ${n(x + w)} ${n(y + radius)}`,
    `V ${n(y + h - radius)}`,
    `A ${n(radius)} ${n(radius)} 0 0 1 ${n(x + w - radius)} ${n(y + h)}`,
    `H ${n(x + radius)}`,
    `A ${n(radius)} ${n(radius)} 0 0 1 ${n(x)} ${n(y + h - radius)}`,
    `V ${n(y + radius)}`,
    `A ${n(radius)} ${n(radius)} 0 0 1 ${n(x + radius)} ${n(y)}`,
    'Z',
  ].join(' ');
}

/**
 * A star with `points` tips alternating between two radii.
 *
 * Used for both spiky shapes: `spike` takes the tips straight, `burst` rounds
 * them off into scallops by drawing arcs between them instead of lines.
 */
function starPoints(cx: number, cy: number, rx: number, ry: number, points: number, inner: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    // Starts at -90° so a tip sits at the top, which is what makes it read as a
    // star rather than as a rotated polygon.
    const angle = (Math.PI * i) / points - Math.PI / 2;
    const scale = i % 2 === 0 ? 1 : inner;
    out.push({ x: cx + Math.cos(angle) * rx * scale, y: cy + Math.sin(angle) * ry * scale });
  }
  return out;
}

// --- the shapes ------------------------------------------------------------

interface Drawn {
  path: string;
  tail: string;
  accents: string[];
}

/**
 * A tail from the bubble's underside back to `tip`.
 *
 * The base is pinned to whichever part of the underside is nearest the speaker,
 * and widened with the distance it has to cover. Anchoring it at a fixed
 * fraction of the width instead — the obvious version — rakes a long thin
 * sliver diagonally across the bubble whenever the speaker is off to one side,
 * which is exactly where this one always is.
 */
function spikeTail(x: number, y: number, w: number, tip: Pt): string {
  const baseX = Math.max(x + w * 0.04, Math.min(tip.x + 12, x + w * 0.3));
  const span = Math.hypot(baseX - tip.x, y - tip.y);
  const width = Math.max(14, Math.min(span * 0.55, w * 0.3));
  return polygon([
    { x: baseX, y },
    { x: baseX + width, y },
    tip,
  ]);
}

function drawShape(kind: BubbleKind, x: number, y: number, w: number, h: number, tip: Pt): Drawn {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const bottom = y + h;

  switch (kind) {
    case 'oval':
      return {
        path: ellipsePath(cx, cy, w / 2, h / 2),
        // Off the lower curve rather than the box edge, or it would hang in
        // the gap between the ellipse and its bounding box.
        tail: spikeTail(x, cy + (h / 2) * 0.9, w, tip),
        accents: [],
      };

    case 'pill':
      return {
        path: roundedRect(x, y, w, h, h / 2),
        tail: spikeTail(x, bottom, w, tip),
        accents: [],
      };

    case 'square':
      return {
        path: polygon([
          { x, y },
          { x: x + w, y },
          { x: x + w, y: bottom },
          { x, y: bottom },
        ]),
        tail: spikeTail(x, bottom, w, tip),
        accents: [],
      };

    case 'banner': {
      // A parallelogram: the top edge runs ahead of the bottom one.
      const slant = Math.min(w * 0.08, h * 0.9);
      return {
        path: polygon([
          { x: x + slant, y },
          { x: x + w, y },
          { x: x + w - slant, y: bottom },
          { x, y: bottom },
        ]),
        tail: spikeTail(x, bottom, w, tip),
        accents: [],
      };
    }

    case 'sketch': {
      const r = Math.min(10, h / 2);
      // A second pass, offset and slightly out of true, is what reads as
      // hand-drawn — a single wobbly line just reads as a wonky rectangle.
      return {
        path: roundedRect(x, y, w, h, r),
        tail: spikeTail(x, bottom, w, tip),
        accents: [
          // Inside the rect, not around it: the offset pass is what reads as
          // hand-drawn, and it has to obey the same bounds as the body.
          roundedRect(x + 2.5, y + 2, w - 5, h - 4, Math.max(2, r - 2)),
          `M ${n(x + w * 0.14)} ${n(y + 4)} H ${n(x + w * 0.6)}`,
        ],
      };
    }

    case 'cloud': {
      // Irregular lobes on an ellipse, same construction as the burst but with
      // fewer, larger, uneven bumps.
      //
      // Quadratic rather than arcs, and that is the point: a quadratic curve
      // never leaves the triangle of its own control points, so keeping those
      // inside the rect proves the whole shape is inside it. The arc-based
      // version this replaces bulged well past its left edge — invisible to a
      // test that only checked endpoints, and visible immediately on screen.
      const lobes = 7;
      // Uneven on purpose: equal bumps read as a gear, not a cloud.
      const swell = [1, 0.86, 0.98, 0.8, 1, 0.84, 0.94];
      const baseX = w / 2 / CLOUD_BULGE;
      const baseY = h / 2 / CLOUD_BULGE;

      const at = (i: number, rx: number, ry: number): Pt => {
        const angle = (Math.PI * 2 * i) / lobes - Math.PI / 2;
        return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
      };

      const first = at(0, baseX, baseY);
      const body = [`M ${n(first.x)} ${n(first.y)}`];
      for (let i = 0; i < lobes; i++) {
        const bulge = swell[i % swell.length];
        const control = at(i + 0.5, (w / 2) * bulge, (h / 2) * bulge);
        const end = at(i + 1, baseX, baseY);
        body.push(`Q ${n(control.x)} ${n(control.y)} ${n(end.x)} ${n(end.y)}`);
      }
      body.push('Z');

      return {
        path: body.join(' '),
        tail: spikeTail(x, cy + baseY * 0.85, w, tip),
        accents: [],
      };
    }

    case 'burst': {
      // Scalloped, built as bumps on an ellipse: on-curve points sit on a base
      // ellipse and each control point pushes outward to the full radius, so
      // every bump is a smooth lobe. The earlier version joined alternating
      // star vertices with small arcs, which crossed itself and read as a saw.
      const bumps = 12;
      const outerX = w / 2;
      const outerY = h / 2;
      const baseX = outerX / BURST_BULGE;
      const baseY = outerY / BURST_BULGE;

      const at = (i: number, rx: number, ry: number): Pt => {
        const angle = (Math.PI * 2 * i) / bumps - Math.PI / 2;
        return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
      };

      const start = at(0, baseX, baseY);
      const body = [`M ${n(start.x)} ${n(start.y)}`];
      for (let i = 0; i < bumps; i++) {
        const control = at(i + 0.5, outerX, outerY);
        const end = at(i + 1, baseX, baseY);
        body.push(`Q ${n(control.x)} ${n(control.y)} ${n(end.x)} ${n(end.y)}`);
      }
      body.push('Z');

      // The little radiating ticks at the corners, as in the reference. Inside
      // the rect, because the rect is what the flight bounds reserve.
      const ticks: string[] = [];
      for (const [dx, dy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        const sx = cx + dx * baseX * 0.78;
        const sy = cy + dy * baseY * 0.78;
        ticks.push(
          `M ${n(sx)} ${n(sy)} L ${n(sx + dx * outerX * 0.1)} ${n(sy + dy * outerY * 0.14)}`,
        );
      }
      return { path: body.join(' '), tail: '', accents: ticks };
    }

    case 'spike':
      // No tail: a shout does not need to point at who is shouting, and the
      // reference sheet's starburst has none either.
      return {
        path: polygon(starPoints(cx, cy, w / 2, h / 2, 16, 0.86)),
        tail: '',
        accents: [],
      };
  }
}

// --- selection -------------------------------------------------------------

/**
 * Which shape a given seed gets.
 *
 * Exported so a caller can pin one — and so the distribution is testable, which
 * matters: a picker that quietly favoured one shape would look like chance.
 */
export function bubbleKind(seed: number): BubbleKind {
  const i = Math.abs(Math.trunc(seed)) % BUBBLE_KINDS.length;
  return BUBBLE_KINDS[i];
}

/**
 * A bubble sized to `text`, in one of the eight shapes.
 *
 * Placed above and to the right of the anchor: the drone's reach is widest
 * across its rotor discs and its shadow sits below it, so that corner is the
 * only side where a box cannot overlap the thing it belongs to.
 *
 * `size` is the speaker's own size, used only to stand the bubble off it.
 */
export function chatBubble(text: string, size: number, seed = 0, kind = bubbleKind(seed)): ChatBubble {
  const pad = SHAPE_PAD[kind];
  const innerW = Math.max(1, text.length) * CHAT_CHAR_W;
  const w = innerW + pad.x * 2;
  const h = CHAT_FONT + pad.y * 2;

  const x = size * 0.75 + CHAT_GAP;
  const y = -(size * 1.15) - h;

  // Where the tail should end up: just off the airframe, not on it.
  const tip: Pt = { x: size * 0.3, y: -(size * 0.7) };
  const { path, tail, accents } = drawShape(kind, x, y, w, h, tip);

  return {
    kind,
    text,
    x,
    y,
    w,
    h,
    path,
    tail,
    accents,
    textX: x + pad.x,
    // Baseline rather than centring with dominant-baseline, which is
    // inconsistent across engines. This only has to agree with itself.
    textY: y + pad.y + CHAT_FONT * 0.8,
  };
}
