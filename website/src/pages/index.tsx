import type {ReactNode} from 'react';
import clsx from 'clsx';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

// A public Spline (spline.design) scene URL for the 3D "yv" wordmark, e.g.
// "https://my.spline.design/<scene-id>/". Authored in the Spline editor, not
// here. Falls back to the plain text title until one is set.
const SPLINE_SCENE_URL = '';

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <header className={clsx('hero hero--primary', styles.heroBanner)}>
        <div className={styles.blobBackground}>
          <div className={clsx(styles.blob, styles.blob1)} />
          <div className={clsx(styles.blob, styles.blob2)} />
          <div className={clsx(styles.blob, styles.blob3)} />
        </div>
        <div className={clsx('container', styles.heroContent)}>
          {SPLINE_SCENE_URL ? (
            <iframe
              src={SPLINE_SCENE_URL}
              title={siteConfig.title}
              className={styles.splineFrame}
              loading="lazy"
            />
          ) : (
            <Heading as="h1" className="hero__title">
              {siteConfig.title}
            </Heading>
          )}
          <p className="hero__subtitle">{siteConfig.tagline}</p>
        </div>
      </header>
    </Layout>
  );
}
