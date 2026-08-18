import type {ReactNode} from 'react';
import clsx from 'clsx';
import useBaseUrl from '@docusaurus/useBaseUrl';

import styles from './Showcase.module.css';

/** Two screenshots on a slight tilt: the command list, and the discovery map. */
export default function Showcase(): ReactNode {
  return (
    <section className={styles.showcase}>
      <div className="container">
        <div className={styles.stack}>
          <img
            src={useBaseUrl('/img/projects.png')}
            alt="Projects and commands, run with one click"
            className={clsx(styles.stackImage, styles.stackImage1)}
          />
          <img
            src={useBaseUrl('/img/device-discovery.png')}
            alt="Nearby devices found over mDNS on the discovery map"
            className={clsx(styles.stackImage, styles.stackImage2)}
          />
        </div>
      </div>
    </section>
  );
}
