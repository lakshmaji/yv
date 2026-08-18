import type {ReactNode} from 'react';
import {useEffect, useRef} from 'react';
import clsx from 'clsx';
import {animate, stagger} from 'animejs';

import useReducedMotion from '@site/src/hooks/useReducedMotion';
import styles from './AnimatedWordmark.module.css';

/** The site title, dealt out one letter at a time. */
export default function AnimatedWordmark({text}: {text: string}): ReactNode {
  const ref = useRef<HTMLHeadingElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const letters = ref.current?.querySelectorAll(`.${styles.letter}`);
    if (!letters || reduced) {
      return;
    }
    const animation = animate(letters, {
      opacity: [0, 1],
      translateY: [40, 0],
      rotateX: [90, 0],
      delay: stagger(120),
      duration: 900,
      ease: 'outExpo',
    });
    return () => {
      animation.revert();
    };
  }, [reduced]);

  return (
    <h1 ref={ref} className={clsx('hero__title', styles.title)}>
      {[...text].map((char, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <span key={i} className={styles.letter}>
          {char}
        </span>
      ))}
    </h1>
  );
}
