import type {ReactNode, Ref} from 'react';
import clsx from 'clsx';

import styles from './Planet.module.css';

/**
 * A speech bubble with its tail tip at the local origin.
 *
 * Anchoring at the tail is what lets the timeline animate a plain `scale` on
 * this group and have the bubble grow out of the animal's mouth: the transform
 * origin of an SVG group is its own (0,0), so no `transform-origin` juggling is
 * needed.
 */
export default function Bubble({
  text,
  bubbleRef,
  className,
  flip = false,
}: {
  text: string;
  bubbleRef?: Ref<SVGGElement>;
  className?: string;
  /** Put the tail on the right, for an animal standing to the left of centre. */
  flip?: boolean;
}): ReactNode {
  const width = Math.max(76, text.length * 7.1 + 26);
  const height = 32;
  const top = -12 - height;
  const tail = flip ? 12 : -12;

  return (
    <g ref={bubbleRef} className={clsx(styles.bubble, className)}>
      <path d={`M 0 0 L ${tail - 7} -13 L ${tail + 7} -13 Z`} className={styles.bubbleSkin} />
      <rect
        x={tail - width / 2}
        y={top}
        width={width}
        height={height}
        rx={10}
        className={styles.bubbleSkin}
      />
      <text x={tail} y={top + height / 2 + 0.5} className={styles.bubbleText}>
        {text}
      </text>
    </g>
  );
}
