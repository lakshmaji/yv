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
 * Deliberately chibi: an oversized head on a small round body, one big eye, a
 * short smile, stubby legs. Anatomically-proportioned dinosaurs at this size
 * read as lizards — the head has to be roughly a third of the animal before it
 * reads as friendly.
 *
 * Built from primitives rather than a single silhouette path, so each part stays
 * independently tweakable. That matters here because the only way to check this
 * drawing is to look at it.
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
        cy={parts.body.cy + parts.body.ry * 0.36}
        rx={parts.body.rx * 0.6}
        ry={parts.body.ry * 0.46}
        className={styles.dinoBelly}
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
          <circle cx={head.nostril.x} cy={head.nostril.y} r={1.3} className={styles.nostril} />
          <circle cx={head.eye.x} cy={head.eye.y} r={head.eye.r} className={styles.eyeWhite} />
          <circle
            cx={head.eye.x + head.eye.r * 0.28}
            cy={head.eye.y + head.eye.r * 0.08}
            r={head.eye.r * 0.54}
            className={styles.eyePupil}
          />
          <circle
            cx={head.eye.x + head.eye.r * 0.62}
            cy={head.eye.y - head.eye.r * 0.42}
            r={head.eye.r * 0.22}
            className={styles.eyeGlint}
          />
        </g>
      </g>
    </g>
  );
}

interface Art {
  tail: string;
  tailWidth: number;
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
  // The head has to clear the body, or the two round shapes merge into one blob
  // and the animal reads as a teddy bear. Hence a smaller skull sitting higher
  // than cuteness alone would ask for.
  theropod: {
    tail: 'M -12 -25 Q -32 -22 -45 -9',
    tailWidth: 13,
    legsBack: ['M -6 -18 L -7 -6', 'M -11 -5 L -2 -5'],
    legsFront: ['M 7 -18 L 6 -6', 'M 1 -5 L 11 -5'],
    legWidth: 12,
    arm: 'M 13 -26 L 19 -23',
    body: {cx: -1, cy: -24, rx: 18, ry: 15},
    neck: {x: 9, y: -41},
    head: {
      neck: 'M -2 5 L 0 -1',
      neckWidth: 14,
      skull: {cx: 3, cy: -12, rx: 15, ry: 13},
      // Juts well past the skull, or it reads as a lump on a bear's head
      // rather than a muzzle.
      snout: {cx: 22, cy: -4, rx: 11, ry: 8.5},
      smile: 'M 18 2 Q 23 5 28 1',
      cheek: {cx: 2, cy: -4, r: 3.6},
      nostril: {x: 31, y: -6},
      eye: {x: 6, y: -14, r: 5.2},
    },
  },
  sauropod: {
    tail: 'M -16 -24 Q -36 -28 -50 -20',
    tailWidth: 10,
    legsBack: ['M -12 -15 L -13 -4', 'M 7 -16 L 8 -4'],
    legsFront: ['M -2 -14 L -3 -4', 'M 15 -15 L 16 -4'],
    legWidth: 12,
    body: {cx: 0, cy: -23, rx: 22, ry: 17},
    neck: {x: 12, y: -32},
    head: {
      neck: 'M 0 2 Q 10 -10 14 -24',
      neckWidth: 14,
      skull: {cx: 16, cy: -30, rx: 11.5, ry: 10},
      snout: {cx: 25, cy: -27, rx: 6.5, ry: 5.5},
      smile: 'M 21 -24 Q 25 -21 28 -24',
      cheek: {cx: 13, cy: -25, r: 3.2},
      nostril: {x: 29, y: -29},
      eye: {x: 17, y: -32, r: 4.8},
    },
  },
  stegosaur: {
    tail: 'M -16 -24 Q -34 -27 -45 -34',
    tailWidth: 10,
    plates: [
      'M -18 -34 Q -15 -48 -7 -35 Z',
      'M -8 -37 Q -3 -52 5 -37 Z',
      'M 4 -36 Q 10 -49 16 -35 Z',
    ],
    legsBack: ['M -11 -14 L -12 -4', 'M 7 -14 L 8 -4'],
    legsFront: ['M -2 -13 L -3 -4', 'M 14 -14 L 15 -4'],
    legWidth: 11,
    body: {cx: 0, cy: -22, rx: 21, ry: 16},
    neck: {x: 15, y: -26},
    head: {
      neck: 'M 0 2 L 4 -2',
      neckWidth: 12,
      skull: {cx: 12, cy: -8, rx: 11.5, ry: 10},
      snout: {cx: 21, cy: -5, rx: 6.5, ry: 5.5},
      smile: 'M 17 -2 Q 21 1 24 -2',
      cheek: {cx: 9, cy: -3, r: 3.2},
      nostril: {x: 25, y: -7},
      eye: {x: 13, y: -10, r: 4.8},
    },
  },
};
