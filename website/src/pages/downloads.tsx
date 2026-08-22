import {useEffect, useState, type ReactNode} from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import InstallerButtons from '@site/src/components/InstallerButtons';
import Loading from '@site/src/components/Loading';
import {
  fetchReleases,
  formatSize,
  osOf,
  OS_LABEL,
  RELEASES_URL,
  type OS,
  type Release,
} from '@site/src/lib/releases';
import styles from './downloads.module.css';

const FILTERS: (OS | 'all')[] = ['all', 'macos', 'windows', 'ubuntu'];

export default function Downloads(): ReactNode {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);
  // An index rather than a tag: nothing on this page names a version, so the
  // selection cannot be seeded with one either.
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState<OS | 'all'>('all');

  useEffect(() => {
    let live = true;
    fetchReleases()
      .then((rs) => live && setReleases(rs))
      .catch(() => live && setFailed(true))
      .finally(() => live && setPending(false));
    return () => {
      live = false;
    };
  }, []);

  const release = releases?.[selected];
  const assets = release?.assets.filter(
    (a) => filter === 'all' || osOf(a.name) === filter,
  );

  return (
    <Layout title="Download" description="Every yv release, for macOS, Windows and Ubuntu.">
      <div className={clsx('container', styles.page)}>
        <Heading as="h1">Download</Heading>
        <p>
          Every release, newest first. Each artifact ships with a{' '}
          <code>.sha256</code> checksum beside it.
        </p>

        {/* Always the newest release, whatever the list below has selected —
            someone who scrolled to an old version to read its assets should
            still be one click from the current build. */}
        <InstallerButtons release={releases?.[0] ?? null} />

        {pending && <Loading label="Loading releases…" />}

        {failed && (
          <p>
            The release list could not be loaded — GitHub may be unreachable or
            rate-limiting this network. Everything is on the{' '}
            <a href={RELEASES_URL}>releases page</a>.
          </p>
        )}

        {releases && (
          <div className={styles.layout}>
            <ul className={styles.versions}>
              {releases.map((r, i) => (
                <li key={r.tag}>
                  <button
                    type="button"
                    className={clsx(i === selected && styles.selected)}
                    onClick={() => setSelected(i)}>
                    {r.tag}
                    {i === 0 && <span className={styles.latest}>latest</span>}
                  </button>
                </li>
              ))}
            </ul>

            <div>
              <div className={styles.filters}>
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={clsx(f === filter && styles.selected)}
                    onClick={() => setFilter(f)}>
                    {f === 'all' ? 'All' : OS_LABEL[f]}
                  </button>
                ))}
              </div>

              {assets?.length ? (
                <table className={styles.assets}>
                  <tbody>
                    {assets.map((a) => (
                      <tr key={a.name}>
                        <td>
                          <a href={a.url}>{a.name}</a>
                        </td>
                        <td className={styles.meta}>{formatSize(a.size)}</td>
                        <td className={styles.meta}>
                          {a.sha256Url && <a href={a.sha256Url}>sha256</a>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p>Nothing for that platform in {release?.tag}.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
