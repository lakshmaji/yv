import type {ReactNode} from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

export default function Demo(): ReactNode {
  return (
    <Layout title="Demo" description="See yv in action">
      <header className={clsx('hero hero--primary', styles.heroBanner)}>
        <div className={styles.blobBackground}>
          <div className={clsx(styles.blob, styles.blob1)} />
          <div className={clsx(styles.blob, styles.blob2)} />
          <div className={clsx(styles.blob, styles.blob3)} />
        </div>
        <div className={clsx('container', styles.heroContent)}>
          <Heading as="h1" className="hero__title">
            Demo
          </Heading>
          <p className="hero__subtitle">Coming soon.</p>
        </div>
      </header>
    </Layout>
  );
}
