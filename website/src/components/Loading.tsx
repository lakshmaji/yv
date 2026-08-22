import type {ReactNode} from 'react';
import clsx from 'clsx';

import styles from './Loading.module.css';

/**
 * A spinner with a label, for the gap between a page rendering and its data
 * arriving. `role="status"` so a screen reader announces the wait rather than
 * finding an empty region.
 */
export default function Loading({
  label = 'Loading…',
  className,
}: {
  label?: string;
  className?: string;
}): ReactNode {
  return (
    <div className={clsx(styles.loading, className)} role="status" aria-live="polite">
      <span className={styles.spinner} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
