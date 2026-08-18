import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

import BlobHero from '@site/src/components/BlobHero';
import AnimatedWordmark from './AnimatedWordmark';
import Planet from './planet/Planet';
import styles from './Hero.module.css';

export default function Hero(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <BlobHero>
      <AnimatedWordmark text={siteConfig.title} />
      <p className={clsx('hero__subtitle', styles.tagline)}>{siteConfig.tagline}</p>
      <div className={styles.ctas}>
        <Link className="button button--primary button--lg" to="/docs/FEATURES">
          Get started
        </Link>
        <Link className="button button--secondary button--lg" to="/docs/docs/yv-yaml">
          The yv.yaml spec
        </Link>
      </div>
      <Planet />
    </BlobHero>
  );
}
