import type {ReactNode} from 'react';
import clsx from 'clsx';

import styles from './BlobHero.module.css';

/**
 * The hero shell both top-level pages share: a full-bleed band with three
 * drifting blurred blobs behind whatever is passed as children.
 *
 * `className` exists for `hero--primary`, which the demo page wants and the home
 * page deliberately does not — the solid primary fill washes the blobs out.
 */
export default function BlobHero({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <header className={clsx('hero', styles.banner, className)}>
      <div className={styles.blobs} aria-hidden="true">
        <div className={clsx(styles.blob, styles.blob1)} />
        <div className={clsx(styles.blob, styles.blob2)} />
        <div className={clsx(styles.blob, styles.blob3)} />
      </div>
      <div className={clsx('container', styles.content)}>{children}</div>
    </header>
  );
}
