import { describe, it, expect } from 'vitest';
import {
  BUBBLE_KINDS,
  bubbleKind,
  chatBubble,
  CHAT_CHAR_W,
  CHAT_FONT,
  type BubbleKind,
} from './chatBubble';
import { droneInsets, DRONE_SIZE, DEFAULT_VARIANT } from './drone';
import { insetRect, type Rect } from './viewbox';

const SPEAKER = DRONE_SIZE;
const TEXT = 'Found 3 rare dinosaurs';

/**
 * The points a path actually visits.
 *
 * A real walk of the commands, not a scan for numbers: an arc carries radii and
 * two flags before its endpoint, and reading those as coordinates makes the
 * containment tests below meaningless — they pass or fail on numbers that were
 * never positions. Quadratic control points are included, since a control point
 * outside the box drags the curve out with it.
 */
function coords(d: string): Array<{ x: number; y: number }> {
  const tokens = d.match(/[MLHVAQZ]|-?\d+(?:\.\d+)?/gi) ?? [];
  const out: Array<{ x: number; y: number }> = [];
  let i = 0;
  let x = 0;
  let y = 0;
  const num = () => Number(tokens[i++]);

  while (i < tokens.length) {
    switch (tokens[i++].toUpperCase()) {
      case 'M':
      case 'L':
        x = num();
        y = num();
        out.push({ x, y });
        break;
      case 'H':
        x = num();
        out.push({ x, y });
        break;
      case 'V':
        y = num();
        out.push({ x, y });
        break;
      case 'A':
        num(); // rx
        num(); // ry
        num(); // x-axis rotation
        num(); // large-arc flag
        num(); // sweep flag
        x = num();
        y = num();
        out.push({ x, y });
        break;
      case 'Q': {
        const qx = num();
        const qy = num();
        x = num();
        y = num();
        out.push({ x: qx, y: qy }, { x, y });
        break;
      }
      default: // Z
        break;
    }
  }
  return out;
}

/**
 * Points along an elliptical arc, via the endpoint-to-centre conversion in the
 * SVG spec (F.6.5). Every arc in this file has zero x-axis rotation, which is
 * what keeps this short.
 *
 * Worth the arithmetic: approximating an arc by an envelope around its
 * endpoints is loose enough to fail shapes that are perfectly inside their box,
 * which makes the containment test useless in the direction that matters.
 */
function sampleArc(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  largeArc: number,
  sweep: number,
  x2: number,
  y2: number,
): Array<{ x: number; y: number }> {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [{ x: x2, y: y2 }];

  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;

  // Scale up radii that are too small to join the endpoints, as the spec requires.
  const lambda = (dx2 * dx2) / (rx * rx) + (dy2 * dy2) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc !== sweep ? 1 : -1;
  const num = rx * rx * ry * ry - rx * rx * dy2 * dy2 - ry * ry * dx2 * dx2;
  const den = rx * rx * dy2 * dy2 + ry * ry * dx2 * dx2;
  const coef = sign * Math.sqrt(Math.max(0, num) / den);
  const cxp = (coef * (rx * dy2)) / ry;
  const cyp = (coef * -(ry * dx2)) / rx;
  const cx = cxp + (x1 + x2) / 2;
  const cy = cyp + (y1 + y2) / 2;

  const start = Math.atan2((dy2 - cyp) / ry, (dx2 - cxp) / rx);
  const end = Math.atan2((-dy2 - cyp) / ry, (-dx2 - cxp) / rx);
  let sweepAngle = end - start;
  if (sweep === 0 && sweepAngle > 0) sweepAngle -= Math.PI * 2;
  if (sweep === 1 && sweepAngle < 0) sweepAngle += Math.PI * 2;

  const out: Array<{ x: number; y: number }> = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const t = start + (sweepAngle * i) / steps;
    out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return out;
}

/**
 * Points along the path, curves included.
 *
 * Quadratics are evaluated, and elliptical arcs are approximated by their
 * endpoints plus the extremes of the ellipse they lie on — which over-estimates
 * rather than under-estimates the reach, so a shape that passes here really is
 * inside its box.
 */
function sampleCurves(d: string): Array<{ x: number; y: number }> {
  const tokens = d.match(/[MLHVAQZ]|-?\d+(?:\.\d+)?/gi) ?? [];
  const out: Array<{ x: number; y: number }> = [];
  let i = 0;
  let x = 0;
  let y = 0;
  const num = () => Number(tokens[i++]);
  const push = (px: number, py: number) => out.push({ x: px, y: py });

  while (i < tokens.length) {
    switch (tokens[i++].toUpperCase()) {
      case 'M':
      case 'L':
        x = num();
        y = num();
        push(x, y);
        break;
      case 'H':
        x = num();
        push(x, y);
        break;
      case 'V':
        y = num();
        push(x, y);
        break;
      case 'A': {
        const rx = num();
        const ry = num();
        num(); // x-axis rotation — always 0 here
        const largeArc = num();
        const sweep = num();
        const ex = num();
        const ey = num();
        for (const p of sampleArc(x, y, rx, ry, largeArc, sweep, ex, ey)) push(p.x, p.y);
        x = ex;
        y = ey;
        break;
      }
      case 'Q': {
        const qx = num();
        const qy = num();
        const ex = num();
        const ey = num();
        for (let t = 0; t <= 1; t += 0.05) {
          const u = 1 - t;
          push(u * u * x + 2 * u * t * qx + t * t * ex, u * u * y + 2 * u * t * qy + t * t * ey);
        }
        x = ex;
        y = ey;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

describe('the bubble set', () => {
  it('has eight distinct shapes', () => {
    expect(BUBBLE_KINDS).toHaveLength(8);
    expect(new Set(BUBBLE_KINDS).size).toBe(8);
  });

  it('picks a shape from the seed, and only from the set', () => {
    for (let seed = 0; seed < 200; seed++) {
      expect(BUBBLE_KINDS).toContain(bubbleKind(seed));
    }
  });

  it('is stable for a seed — a bubble must not reshape itself mid-sweep', () => {
    for (const seed of [0, 1, 7, 4242, 20260806]) {
      expect(bubbleKind(seed)).toBe(bubbleKind(seed));
      expect(chatBubble(TEXT, SPEAKER, seed).path).toBe(chatBubble(TEXT, SPEAKER, seed).path);
    }
  });

  it('reaches every shape rather than quietly favouring a few', () => {
    const seen = new Set<BubbleKind>();
    for (let seed = 0; seed < 64; seed++) seen.add(bubbleKind(seed));
    expect(seen.size).toBe(BUBBLE_KINDS.length);
  });

  it('survives a negative or fractional seed', () => {
    // Seeds are XORed hashes, so both are reachable.
    expect(BUBBLE_KINDS).toContain(bubbleKind(-13));
    expect(BUBBLE_KINDS).toContain(bubbleKind(7.9));
  });

  it('can be pinned, so a caller may force one shape', () => {
    for (const kind of BUBBLE_KINDS) {
      expect(chatBubble(TEXT, SPEAKER, 0, kind).kind).toBe(kind);
    }
  });
});

describe('every shape', () => {
  for (const kind of BUBBLE_KINDS) {
    describe(kind, () => {
      const box = chatBubble(TEXT, SPEAKER, 0, kind);

      it('draws a closed body path', () => {
        expect(box.path.startsWith('M')).toBe(true);
        expect(box.path.trim().endsWith('Z')).toBe(true);
      });

      it('carries its text through, so the drawing side needs nothing else', () => {
        expect(box.text).toBe(TEXT);
      });

      it('leaves room for the text it was sized for', () => {
        const textWidth = TEXT.length * CHAT_CHAR_W;
        expect(box.w).toBeGreaterThan(textWidth);
        expect(box.h).toBeGreaterThanOrEqual(CHAT_FONT);
      });

      it('puts the text anchor inside its own box', () => {
        expect(box.textX).toBeGreaterThanOrEqual(box.x);
        expect(box.textX + TEXT.length * CHAT_CHAR_W).toBeLessThanOrEqual(box.x + box.w);
        expect(box.textY).toBeGreaterThan(box.y);
        expect(box.textY).toBeLessThan(box.y + box.h);
      });

      /**
       * The containment guarantee. The flight bounds are inset by exactly this
       * box, so anything drawn outside it is drawn somewhere the drone was never
       * allowed to be — i.e. off the edge of the panel.
       */
      it('keeps its body inside the box the bounds are computed from', () => {
        for (const p of coords(box.path)) {
          expect(p.x).toBeGreaterThanOrEqual(box.x - 1e-6);
          expect(p.x).toBeLessThanOrEqual(box.x + box.w + 1e-6);
          expect(p.y).toBeGreaterThanOrEqual(box.y - 1e-6);
          expect(p.y).toBeLessThanOrEqual(box.y + box.h + 1e-6);
        }
      });

      /**
       * The endpoint test above is necessary but not sufficient: a curve can
       * bow well outside a box whose corners it touches, which is exactly how
       * the first cloud escaped its rect while every endpoint sat inside it.
       *
       * A quadratic never leaves the triangle of its control points, so walking
       * the actual curve — rather than trusting that property — is what makes
       * this a real guarantee.
       */
      it('keeps every point along its curves inside the box', () => {
        for (const p of sampleCurves(box.path)) {
          expect(p.x).toBeGreaterThanOrEqual(box.x - 0.5);
          expect(p.x).toBeLessThanOrEqual(box.x + box.w + 0.5);
          expect(p.y).toBeGreaterThanOrEqual(box.y - 0.5);
          expect(p.y).toBeLessThanOrEqual(box.y + box.h + 0.5);
        }
      });

      // The decorations are part of the drawing, so they answer to the same
      // rect — the burst's ticks were originally drawn outside it.
      it('keeps its accents inside that box too', () => {
        for (const accent of box.accents) {
          for (const p of coords(accent)) {
            expect(p.x).toBeGreaterThanOrEqual(box.x - 1e-6);
            expect(p.x).toBeLessThanOrEqual(box.x + box.w + 1e-6);
            expect(p.y).toBeGreaterThanOrEqual(box.y - 1e-6);
            expect(p.y).toBeLessThanOrEqual(box.y + box.h + 1e-6);
          }
        }
      });

      it('sits above and to the right of the speaker', () => {
        expect(box.x).toBeGreaterThan(0);
        expect(box.y + box.h).toBeLessThan(0);
      });

      it('grows with a longer message', () => {
        const longer = chatBubble(`${TEXT} and then some more`, SPEAKER, 0, kind);
        expect(longer.w).toBeGreaterThan(box.w);
        // Same type size, so only the width moves.
        expect(longer.h).toBe(box.h);
      });

      it('never collapses on an empty string', () => {
        const empty = chatBubble('', SPEAKER, 0, kind);
        expect(empty.w).toBeGreaterThan(0);
        expect(empty.h).toBeGreaterThan(0);
      });

      it('stands further off a bigger speaker', () => {
        const big = chatBubble(TEXT, 60, 0, kind);
        const small = chatBubble(TEXT, 20, 0, kind);
        expect(big.x).toBeGreaterThan(small.x);
        expect(big.y).toBeLessThan(small.y);
        // Text size is fixed, so the box must not scale with the speaker.
        expect(big.w).toBe(small.w);
      });
    });
  }
});

describe('tails and accents', () => {
  it('points a tail back at the speaker on the shapes that have one', () => {
    for (const kind of BUBBLE_KINDS) {
      const box = chatBubble(TEXT, SPEAKER, 0, kind);
      if (!box.tail) continue;
      // The tail has to reach down out of the box, toward the airframe below it.
      const lowest = Math.max(...coords(box.tail).map((p) => p.y));
      expect(lowest).toBeGreaterThan(box.y + box.h * 0.5);
    }
  });

  it('gives the shout shapes no tail, as in the reference sheet', () => {
    expect(chatBubble(TEXT, SPEAKER, 0, 'spike').tail).toBe('');
    expect(chatBubble(TEXT, SPEAKER, 0, 'burst').tail).toBe('');
  });

  it('adds accent strokes only where the shape calls for them', () => {
    expect(chatBubble(TEXT, SPEAKER, 0, 'burst').accents.length).toBeGreaterThan(0);
    expect(chatBubble(TEXT, SPEAKER, 0, 'sketch').accents.length).toBeGreaterThan(0);
    expect(chatBubble(TEXT, SPEAKER, 0, 'square').accents).toEqual([]);
    expect(chatBubble(TEXT, SPEAKER, 0, 'oval').accents).toEqual([]);
  });

  it('emits no NaN, which would silently drop a path', () => {
    for (const kind of BUBBLE_KINDS) {
      const box = chatBubble(TEXT, SPEAKER, 0, kind);
      for (const d of [box.path, box.tail, ...box.accents]) {
        expect(d).not.toMatch(/NaN|Infinity|undefined/);
      }
    }
  });
});

/**
 * The requirement in one place: whatever shape is chosen, a drone flying to the
 * far corner of its permitted bounds must still have its whole bubble on screen.
 */
describe('staying inside the view', () => {
  const canvas: Rect = { x: 0, y: 0, width: 1600, height: 900 };

  for (const kind of BUBBLE_KINDS) {
    it(`keeps a ${kind} bubble on the map at the worst-case corner`, () => {
      const box = chatBubble(TEXT, SPEAKER, 0, kind);
      const bounds = insetRect(canvas, droneInsets(SPEAKER, DEFAULT_VARIANT, box));

      // Top-right: the only corner the bubble can be pushed off, since it is
      // always drawn up and to the right.
      const corner = { x: bounds.x + bounds.width, y: bounds.y };
      expect(corner.x + box.x + box.w).toBeLessThanOrEqual(canvas.x + canvas.width + 1e-6);
      expect(corner.y + box.y).toBeGreaterThanOrEqual(canvas.y - 1e-6);
    });
  }

  it('reserves more room for a wider shape than a tight one', () => {
    // A starburst spends much of its width on spikes, so it must push the drone
    // further from the edge than a square carrying the same message does.
    const spike = chatBubble(TEXT, SPEAKER, 0, 'spike');
    const square = chatBubble(TEXT, SPEAKER, 0, 'square');
    expect(spike.w).toBeGreaterThan(square.w);
    expect(droneInsets(SPEAKER, DEFAULT_VARIANT, spike).right).toBeGreaterThan(
      droneInsets(SPEAKER, DEFAULT_VARIANT, square).right,
    );
  });
});
