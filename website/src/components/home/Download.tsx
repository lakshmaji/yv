import {useEffect, useState, type ReactNode} from 'react';
import Heading from '@theme/Heading';
import Link from '@docusaurus/Link';

import InstallerButtons from '@site/src/components/InstallerButtons';
import Loading from '@site/src/components/Loading';
import {fetchReleases, type Release} from '@site/src/lib/releases';
import styles from './Download.module.css';

export default function Download(): ReactNode {
  const [latest, setLatest] = useState<Release | null>(null);
  const [pending, setPending] = useState(true);

  // A failure is not reported here. The buttons below stay usable without a
  // release — they fall back to the releases page — so the only thing the fetch
  // adds is the version line and the filenames, and "we could not name the
  // file" is not worth an error box over a working download button.
  useEffect(() => {
    let live = true;
    fetchReleases(5)
      .then((releases) => live && setLatest(releases[0] ?? null))
      .catch(() => {})
      .finally(() => live && setPending(false));
    return () => {
      live = false;
    };
  }, []);

  return (
    <section id="download" className={styles.download}>
      <div className="container">
        <Heading as="h2">Download</Heading>
        <div className={styles.version}>
          {pending ? (
            <Loading label="Finding the latest release…" className={styles.loading} />
          ) : latest ? (
            `${latest.tag} — released ${new Date(latest.published).toLocaleDateString()}`
          ) : (
            'The latest build for macOS, Ubuntu and Windows.'
          )}
        </div>

        <InstallerButtons release={latest} />

        <Link className={styles.all} to="/downloads">
          Show all download options →
        </Link>
      </div>
    </section>
  );
}
