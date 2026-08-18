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
 * Composed from overlapping filled primitives with no outline anywhere, so the
 * parts union into a single silhouette instead of showing a seam at every
 * junction. Volume comes from a vertical gradient on the fill, not from strokes.
 *
 * Deliberately chibi: an oversized head, one big eye, a smile, stubby legs.
 * Anatomically-proportioned dinosaurs at this size read as lizards.
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
  const {head} = parts;
  return (
    <g className={TONES[tone]}>
      <path d={parts.tail} className={styles.dinoTail} />
      {parts.plates?.map((d, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <path key={i} d={d} className={styles.dinoFar} />
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
      {parts.legsFront.map((d, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <path key={i} d={d} className={styles.limbFront} strokeWidth={parts.legWidth} />
      ))}
      {parts.arm && <path d={parts.arm} className={styles.limbFront} strokeWidth={5} />}

      <g transform={`translate(${parts.neck.x} ${parts.neck.y})`}>
        <g className={headClassName}>
          <path d={head.neck} className={styles.limbFront} strokeWidth={head.neckWidth} />
          <ellipse
            cx={head.skull.cx}
            cy={head.skull.cy}
            rx={head.skull.rx}
            ry={head.skull.ry}
            className={styles.dinoBody}
          />
          <ellipse
            cx={head.snout.cx}
            cy={head.snout.cy}
            rx={head.snout.rx}
            ry={head.snout.ry}
            className={styles.dinoBody}
          />
          <circle cx={head.cheek.cx} cy={head.cheek.cy} r={head.cheek.r} className={styles.cheek} />
          <path d={head.smile} className={styles.smile} />
          <circle cx={head.nostril.x} cy={head.nostril.y} r={1.4} className={styles.nostril} />
          <circle cx={head.eye.x} cy={head.eye.y} r={head.eye.r} className={styles.eyeWhite} />
          <circle
            cx={head.eye.x + head.eye.r * 0.3}
            cy={head.eye.y + head.eye.r * 0.1}
            r={head.eye.r * 0.56}
            className={styles.eyePupil}
          />
          <circle
            cx={head.eye.x + head.eye.r * 0.66}
            cy={head.eye.y - head.eye.r * 0.44}
            r={head.eye.r * 0.24}
            className={styles.eyeGlint}
          />
        </g>
      </g>
    </g>
  );
}

interface Art {
  /** Filled and tapered, not a uniform stroke — a stick tail reads as a stick. */
  tail: string;
  plates?: string[];
  legsBack: string[];
  legsFront: string[];
  legWidth: number;
  arm?: string;
  body: {cx: number; cy: number; rx: number; ry: number};
  /** Where the head group hangs, and therefore what a nod pivots around. */
  neck: {x: number; y: number};
  head: {
    neck: string;
    neckWidth: number;
    /** The cranium, and a second blob for the muzzle — round, never pointed. */
    skull: {cx: number; cy: number; rx: number; ry: number};
    snout: {cx: number; cy: number; rx: number; ry: number};
    smile: string;
    cheek: {cx: number; cy: number; r: number};
    nostril: {x: number; y: number};
    eye: {x: number; y: number; r: number};
  };
}

/** Head-group contents are relative to `neck`, everything else to the feet. */
const ART: Record<Species, Art> = {
  // The skull is smaller and set higher than cuteness alone would ask, because a
  // big round head on a big round body merges into one blob and reads as a bear.
  // The snout juts well past the skull for the same reason.
  theropod: {
    tail: 'M -8 -32 Q -28 -32 -46 -16 Q -49 -13 -44 -11 Q -26 -14 -6 -17 Z',
    legsBack: ['M -6 -19 L -7 -7', 'M -12 -4 L -2 -4'],
    legsFront: ['M 8 -19 L 7 -7', 'M 2 -4 L 14 -4'],
    legWidth: 13,
    arm: 'M 13 -26 L 19 -23',
    body: {cx: -1, cy: -24, rx: 18, ry: 15},
    neck: {x: 9, y: -41},
    head: {
      neck: 'M -2 5 L 0 -1',
      neckWidth: 15,
      skull: {cx: 3, cy: -12, rx: 15, ry: 13},
      snout: {cx: 22, cy: -4, rx: 11, ry: 8.5},
      smile: 'M 18 2 Q 23 5 28 1',
      cheek: {cx: 2, cy: -4, r: 3.6},
      nostril: {x: 31, y: -6},
      eye: {x: 6, y: -14, r: 5.2},
    },
  },
  sauropod: {
    tail: 'M -8 -30 Q -30 -33 -52 -23 Q -55 -20 -50 -18 Q -28 -16 -6 -15 Z',
    legsBack: ['M -12 -15 L -13 -4', 'M 7 -16 L 8 -4'],
    legsFront: ['M -2 -14 L -3 -4', 'M 15 -15 L 16 -4'],
    legWidth: 13,
    body: {cx: 0, cy: -23, rx: 22, ry: 17},
    neck: {x: 12, y: -32},
    head: {
      neck: 'M 0 3 Q 10 -10 14 -24',
      neckWidth: 15,
      skull: {cx: 16, cy: -30, rx: 11.5, ry: 10},
      snout: {cx: 26, cy: -26, rx: 7, ry: 6},
      smile: 'M 22 -23 Q 26 -20 30 -23',
      cheek: {cx: 12, cy: -25, r: 3.2},
      nostril: {x: 31, y: -28},
      eye: {x: 17, y: -32, r: 4.8},
    },
  },
  stegosaur: {
    tail: 'M -8 -30 Q -28 -34 -46 -43 Q -49 -41 -46 -37 Q -26 -21 -6 -15 Z',
    plates: [
      'M -18 -33 Q -14 -48 -6 -34 Z',
      'M -7 -36 Q -1 -52 6 -36 Z',
      'M 5 -35 Q 11 -48 17 -34 Z',
    ],
    legsBack: ['M -11 -14 L -12 -4', 'M 7 -14 L 8 -4'],
    legsFront: ['M -2 -13 L -3 -4', 'M 14 -14 L 15 -4'],
    legWidth: 12,
    body: {cx: 0, cy: -22, rx: 21, ry: 16},
    neck: {x: 15, y: -26},
    head: {
      neck: 'M 0 2 L 4 -2',
      neckWidth: 13,
      skull: {cx: 12, cy: -8, rx: 11.5, ry: 10},
      snout: {cx: 22, cy: -4, rx: 7, ry: 6},
      smile: 'M 18 -1 Q 22 2 26 -1',
      cheek: {cx: 9, cy: -3, r: 3.2},
      nostril: {x: 27, y: -6},
      eye: {x: 13, y: -10, r: 4.8},
    },
  },
};
