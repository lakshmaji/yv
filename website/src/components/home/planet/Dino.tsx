import type {ReactNode} from 'react';

import type {Species} from './scene';
import styles from './Planet.module.css';

/** Which of the three colourways this animal wears. */
export type Tone = 'a' | 'b' | 'c';

const TONES: Record<Tone, string> = {
  a: styles.dinoA,
  b: styles.dinoB,
  c: styles.dinoC,
};

/**
 * One dinosaur, drawn facing right with its feet on y=0 so `standOn` can drop it
 * straight onto the rim.
 *
 * Built from primitives rather than a single silhouette path: an ellipse body
 * and round-capped strokes for limbs, neck and tail. Flat art reads fine that
 * way and each part stays independently tweakable, which matters here because
 * the only way to check this drawing is to look at it.
 *
 * The head is its own group with its origin at the neck joint, so a nod is one
 * rotation about the right point. Anything the timeline animates gets its own
 * layer — an element can only carry one transform at a time.
 */
export default function Dino({
  species,
  tone,
  headClassName,
}: {
  species: Species;
  tone: Tone;
  /** Marks the head group so the timeline can find it and nod it. */
  headClassName?: string;
}): ReactNode {
  const parts = ART[species];
  return (
    <g className={TONES[tone]}>
      <path d={parts.tail} className={styles.limbBack} strokeWidth={parts.tailWidth} />
      {parts.plates?.map((d, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <path key={i} d={d} className={styles.plate} />
      ))}
      {parts.legsBack.map((d, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <path key={i} d={d} className={styles.limbBack} strokeWidth={parts.legWidth} />
      ))}
      <ellipse
        cx={parts.body.cx}
        cy={parts.body.cy}
        rx={parts.body.rx}
        ry={parts.body.ry}
        className={styles.dinoBody}
      />
      <ellipse
        cx={parts.body.cx + 3}
        cy={parts.body.cy + parts.body.ry * 0.4}
        rx={parts.body.rx * 0.62}
        ry={parts.body.ry * 0.44}
        className={styles.dinoBelly}
      />
      {parts.legsFront.map((d, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <path key={i} d={d} className={styles.limbFront} strokeWidth={parts.legWidth} />
      ))}
      {parts.feet.map((d, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <path key={i} d={d} className={styles.limbFront} strokeWidth={5.5} />
      ))}
      {parts.arm && <path d={parts.arm} className={styles.limbFront} strokeWidth={4} />}

      <g transform={`translate(${parts.neck.x} ${parts.neck.y})`}>
        <g className={headClassName}>
          <path
            d={parts.head.neck}
            className={styles.limbFront}
            strokeWidth={parts.head.neckWidth}
          />
          {parts.head.skull.kind === 'path' ? (
            <path d={parts.head.skull.d} className={styles.dinoBody} />
          ) : (
            <ellipse
              cx={parts.head.skull.cx}
              cy={parts.head.skull.cy}
              rx={parts.head.skull.rx}
              ry={parts.head.skull.ry}
              transform={`rotate(${parts.head.skull.rot} ${parts.head.skull.cx} ${parts.head.skull.cy})`}
              className={styles.dinoBody}
            />
          )}
          {parts.head.snout && (
            <circle
              cx={parts.head.snout.cx}
              cy={parts.head.snout.cy}
              r={parts.head.snout.r}
              className={styles.dinoBody}
            />
          )}
          {parts.head.jaw && <path d={parts.head.jaw} className={styles.jaw} />}
          <circle cx={parts.head.eye.x} cy={parts.head.eye.y} r={3.2} className={styles.eyeWhite} />
          <circle
            cx={parts.head.eye.x + 0.9}
            cy={parts.head.eye.y - 0.3}
            r={1.5}
            className={styles.eyePupil}
          />
        </g>
      </g>
    </g>
  );
}

type Skull =
  | {kind: 'path'; d: string}
  | {kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rot: number};

interface Art {
  tail: string;
  tailWidth: number;
  plates?: string[];
  legsBack: string[];
  legsFront: string[];
  legWidth: number;
  feet: string[];
  arm?: string;
  body: {cx: number; cy: number; rx: number; ry: number};
  /** Where the head group hangs, and therefore what a nod pivots around. */
  neck: {x: number; y: number};
  head: {
    neck: string;
    neckWidth: number;
    skull: Skull;
    snout?: {cx: number; cy: number; r: number};
    jaw?: string;
    eye: {x: number; y: number};
  };
}

/** Head-group contents are relative to `neck`, everything else to the feet. */
const ART: Record<Species, Art> = {
  // Heavy head, heavy tail, two legs under the hips. Without the weight at both
  // ends a two-legged animal this size just reads as a rabbit.
  theropod: {
    tail: 'M -14 -32 Q -40 -32 -60 -16',
    tailWidth: 13,
    legsBack: ['M -4 -26 L -11 -14 L -3 -3'],
    legsFront: ['M 9 -26 L 3 -13 L 12 -3'],
    legWidth: 11,
    feet: ['M -6 -3 L 6 -3', 'M 9 -3 L 21 -3'],
    arm: 'M 16 -34 L 23 -29 L 21 -24',
    body: {cx: -2, cy: -31, rx: 22, ry: 15.5},
    neck: {x: 11, y: -40},
    head: {
      neck: 'M -2 3 L 2 -6',
      neckWidth: 14,
      // A wedge that tapers to a snout, not an oval. The oval version read as a
      // rabbit from across the page.
      skull: {
        kind: 'path',
        d: 'M -3 -13 Q 9 -25 24 -22 L 45 -15 Q 52 -11 45 -6 L 19 -1 Q 1 1 -3 -13 Z',
      },
      jaw: 'M 17 -5 L 46 -9',
      eye: {x: 26, y: -14},
    },
  },
  sauropod: {
    tail: 'M -18 -32 Q -44 -40 -64 -30',
    tailWidth: 10,
    legsBack: ['M -13 -20 L -14 -3', 'M 9 -21 L 10 -3'],
    legsFront: ['M -4 -19 L -5 -3', 'M 17 -20 L 18 -3'],
    legWidth: 11,
    feet: ['M -10 -3 L 1 -3', 'M 12 -3 L 23 -3'],
    body: {cx: 0, cy: -31, rx: 26, ry: 18},
    neck: {x: 14, y: -41},
    head: {
      neck: 'M 0 2 Q 14 -12 20 -32',
      neckWidth: 12,
      skull: {kind: 'ellipse', cx: 23, cy: -37, rx: 10, ry: 7, rot: -22},
      snout: {cx: 30, cy: -40, r: 4.6},
      eye: {x: 23, y: -39},
    },
  },
  // Plates as rounded fins rather than spikes — sharp triangles at this scale
  // turned the whole animal into a hedgehog.
  stegosaur: {
    tail: 'M -18 -30 Q -40 -35 -56 -46',
    tailWidth: 9,
    plates: [
      'M -20 -38 Q -18 -55 -9 -39 Z',
      'M -10 -41 Q -5 -61 3 -41 Z',
      'M 3 -41 Q 9 -58 16 -40 Z',
      'M 15 -37 Q 20 -50 25 -36 Z',
    ],
    legsBack: ['M -12 -18 L -13 -3', 'M 8 -18 L 9 -3'],
    legsFront: ['M -4 -17 L -5 -3', 'M 15 -18 L 16 -3'],
    legWidth: 10,
    feet: ['M -10 -3 L 0 -3', 'M 11 -3 L 21 -3'],
    body: {cx: 0, cy: -29, rx: 24, ry: 16},
    neck: {x: 18, y: -35},
    head: {
      neck: 'M 0 3 L 6 -4',
      neckWidth: 10,
      skull: {kind: 'ellipse', cx: 14, cy: -7, rx: 10, ry: 6.5, rot: -12},
      snout: {cx: 22, cy: -7, r: 4},
      eye: {x: 15, y: -9},
    },
  },
};
