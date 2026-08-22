import type {ReactNode} from 'react';

import {
  formatSize,
  installerFor,
  LATEST_URL,
  OS_LABEL,
  type OS,
  type Release,
} from '@site/src/lib/releases';
import styles from './InstallerButtons.module.css';

const OSES: OS[] = ['macos', 'ubuntu', 'windows'];

/**
 * One button per platform, for the artifact a person should actually install.
 *
 * `release` is null before the fetch lands, on the server, and whenever GitHub
 * is unreachable or rate-limiting. All three render the same thing: a button
 * pointing at the releases page, which is what the site linked to before this
 * existed. There is no state here that renders as empty or disabled.
 */
export default function InstallerButtons({
  release,
}: {
  release: Release | null;
}): ReactNode {
  return (
    <div className={styles.row}>
      {OSES.map((os) => {
        const asset = release ? installerFor(release, os) : undefined;
        return (
          <a
            key={os}
            className="button button--primary button--lg"
            href={asset?.url ?? LATEST_URL}>
            <span>Download for {OS_LABEL[os]}</span>
            <span className={styles.file}>
              {asset
                ? `${asset.name} · ${formatSize(asset.size)}`
                : 'Latest release'}
            </span>
          </a>
        );
      })}
    </div>
  );
}
