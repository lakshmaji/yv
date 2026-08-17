import type {ReactNode} from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

export default function Demo(): ReactNode {
  return (
    <Layout title="Demo" description="See yv in action">
      <header className={clsx('hero hero--primary', styles.heroBanner)}>
        <div className="container">
          <Heading as="h1" className="hero__title">
            Demo
          </Heading>
          <p className="hero__subtitle">Coming soon.</p>
        </div>
      </header>
    </Layout>
  );
}
