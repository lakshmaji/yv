import type {ReactNode} from 'react';
import {useEffect, useRef} from 'react';
import clsx from 'clsx';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import {animate, stagger} from 'animejs';

import styles from './index.module.css';

function AnimatedTitle({text}: {text: string}) {
  const ref = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const letters = ref.current?.querySelectorAll(`.${styles.letter}`);
    if (!letters || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    animate(letters, {
      opacity: [0, 1],
      translateY: [40, 0],
      rotateX: [90, 0],
      delay: stagger(120),
      duration: 900,
      ease: 'outExpo',
    });
  }, []);

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

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <header className={clsx('hero', styles.heroBanner)}>
        <div className={styles.blobBackground}>
          <div className={clsx(styles.blob, styles.blob1)} />
          <div className={clsx(styles.blob, styles.blob2)} />
          <div className={clsx(styles.blob, styles.blob3)} />
        </div>
        <div className={clsx('container', styles.heroContent)}>
          <AnimatedTitle text={siteConfig.title} />
          <p className="hero__subtitle">{siteConfig.tagline}</p>
        </div>
      </header>
    </Layout>
  );
}
