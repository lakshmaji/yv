import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import InstallerButtons from '@site/src/components/InstallerButtons';
import Loading from '@site/src/components/Loading';
import {
  decodeBuildId,
  defaultOS,
  encodeBuildId,
  fetchReleases,
  fetchReleasesPage,
  formatPublished,
  formatSize,
  installerFor,
  OS_LABEL,
  RELEASES_URL,
  type Asset,
  type OS,
  type Release,
} from '@site/src/lib/releases';
import styles from './downloads.module.css';

const OSES: OS[] = ['macos', 'windows', 'ubuntu'];
const PAGE_SIZE = 10;

/** Share glyph: three connected nodes, matching common OS share icons. */
function ShareIcon(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.6" y1="10.5" x2="15.4" y2="6.5" />
      <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
    </svg>
  );
}

/** Checkmark shown briefly in place of {@link ShareIcon} after a copy. */
function CheckIcon(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** Download glyph: an arrow into a tray, for the per-row download button. */
function DownloadIcon(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <path d="M12 3v12" />
      <polyline points="7 10 12 15 17 10" />
      <path d="M4 19h16" />
    </svg>
  );
}

export default function Downloads(): ReactNode {
  const [latest, setLatest] = useState<Release | null>(null);
  const [releases, setReleases] = useState<Release[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [pending, setPending] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [os, setOs] = useState<OS>('macos');
  // Which row's share button last copied a link, so only that one flips to a
  // checkmark rather than every row on the page.
  const [copiedTag, setCopiedTag] = useState<string | null>(null);
  // A shared link's build, highlighted once the matching row renders.
  const [highlightTag, setHighlightTag] = useState<string | null>(null);
  // A shared link's ?b=<id> target, kept around until its row has loaded (or
  // the feed runs out) so pagination can be driven to find it automatically.
  const [pendingBuild, setPendingBuild] = useState<{tag: string; os: OS} | null>(null);

  const liveRef = useRef(true);
  const loadingRef = useRef(false);

  const loadNextPage = useCallback((p: number) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadingMore(true);
    fetchReleasesPage(p, PAGE_SIZE)
      .then(({releases: rs, hasMore: more}) => {
        if (!liveRef.current) return;
        setReleases((prev) => [...prev, ...rs]);
        setPage(p + 1);
        setHasMore(more);
        setLoadMoreFailed(false);
      })
      .catch(() => {
        if (!liveRef.current) return;
        if (p === 1) setFailed(true);
        else setLoadMoreFailed(true);
      })
      .finally(() => {
        loadingRef.current = false;
        if (liveRef.current) {
          setLoadingMore(false);
          setPending(false);
        }
      });
  }, []);

  useEffect(() => {
    liveRef.current = true;
    setOs(defaultOS());
    setPendingBuild(decodeBuildId(new URLSearchParams(window.location.search).get('b')));
    // Always the newest release, whatever pagination below has loaded —
    // someone who scrolled to an old version should still be one click from
    // the current build.
    fetchReleases(1)
      .then((rs) => liveRef.current && setLatest(rs[0] ?? null))
      .catch(() => {});
    loadNextPage(1);
    return () => {
      liveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Loads more pages, scroll position aside, while a shared ?b=<id> link's
  // target hasn't shown up yet — so a shared link resolves without the
  // visitor needing to scroll to trigger the sentinel below. Stops once
  // found, or once the feed is exhausted (hasMore false).
  useEffect(() => {
    if (!pendingBuild) return;
    const match = releases.find((r) => r.tag === pendingBuild.tag);
    if (match) {
      setHighlightTag(match.tag);
      setOs(pendingBuild.os);
      setPendingBuild(null);
      return;
    }
    if (!hasMore) {
      setPendingBuild(null);
      return;
    }
    loadNextPage(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [releases, hasMore]);

  // Fetches the next page once the sentinel row scrolls near the viewport.
  const sentinelRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadNextPage(page);
      },
      {rootMargin: '200px'},
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, page, loadNextPage]);

  // Triggers the download from a real <button>, not a visible <a> — so
  // hovering it never shows the asset's raw URL in the browser's link
  // preview the way a styled anchor would.
  function downloadAsset(asset: Asset) {
    const link = document.createElement('a');
    link.href = asset.url;
    link.download = asset.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function copyLink(tag: string) {
    const url = new URL(window.location.href);
    url.searchParams.set('b', encodeBuildId(tag, os));
    const link = url.toString();
    if (!navigator.clipboard) {
      window.prompt('Copy this link:', link);
      return;
    }
    navigator.clipboard
      .writeText(link)
      .then(() => {
        setCopiedTag(tag);
        setTimeout(() => setCopiedTag(null), 1500);
      })
      .catch(() => window.prompt('Copy this link:', link));
  }

  return (
    <Layout title="Download" description="Every yv release, for macOS, Windows and Ubuntu.">
      <div className={clsx('container', styles.page)}>
        <Heading as="h1">Download</Heading>
        <p>
          Every release, newest first. Each artifact ships with a{' '}
          <code>.sha256</code> checksum beside it.
        </p>

        <InstallerButtons release={latest} />

        {pending && <Loading label="Loading releases…" />}

        {failed && (
          <p>
            The release list could not be loaded — GitHub may be unreachable or
            rate-limiting this network. Everything is on the{' '}
            <a href={RELEASES_URL}>releases page</a>.
          </p>
        )}

        {!pending && !failed && (
          <div className={styles.filtersGroup}>
            <span className={styles.panelLabel}>Platform</span>
            <div className={styles.filters}>
              {OSES.map((o) => (
                <button
                  key={o}
                  type="button"
                  aria-pressed={o === os}
                  className={clsx(o === os && styles.selected)}
                  onClick={() => setOs(o)}>
                  {OS_LABEL[o]}
                </button>
              ))}
            </div>
          </div>
        )}

        {!pending && !failed && (
          <div className={styles.versionsPanel}>
            <span className={styles.panelLabel}>Versions</span>
            <ul className={styles.versions}>
              {releases.map((r, i) => {
                const asset = installerFor(r, os);
                return (
                  <li
                    key={r.tag}
                    className={clsx(
                      styles.versionRow,
                      r.tag === highlightTag && styles.selected,
                    )}>
                    <span className={styles.versionLabel} title={r.tag}>
                      <span className={styles.versionNumber}>{r.tag}</span>
                      <span
                        className={clsx(styles.latest, i !== 0 && styles.latestHidden)}>
                        Latest
                      </span>
                    </span>

                    {asset ? (
                      <>
                        <span className={styles.released}>
                          {formatPublished(r.published)}
                        </span>
                        <span className={styles.size}>
                          {formatSize(asset.size)}
                          {asset.sha256Url && (
                            <>
                              {' · '}
                              <a href={asset.sha256Url} className={styles.sha256Link}>
                                sha256
                              </a>
                            </>
                          )}
                        </span>
                        <div className={styles.actions}>
                          <button
                            type="button"
                            className={styles.downloadButton}
                            onClick={() => downloadAsset(asset)}>
                            <DownloadIcon />
                            Download
                          </button>
                          <button
                            type="button"
                            className={styles.shareButton}
                            aria-label={
                              copiedTag === r.tag ? 'Link copied' : 'Copy link to this build'
                            }
                            title={
                              copiedTag === r.tag ? 'Link copied' : 'Copy link to this build'
                            }
                            onClick={() => copyLink(r.tag)}>
                            {copiedTag === r.tag ? <CheckIcon /> : <ShareIcon />}
                          </button>
                        </div>
                      </>
                    ) : (
                      <span className={styles.unavailable}>
                        Not built for {OS_LABEL[os]}
                      </span>
                    )}
                  </li>
                );
              })}
              {hasMore && (
                <li ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />
              )}
            </ul>
            {loadingMore && <p className={styles.loadingMore}>Loading more…</p>}
            {loadMoreFailed && (
              <p className={styles.loadMoreFailed}>
                Couldn't load more releases.{' '}
                <button type="button" onClick={() => loadNextPage(page)}>
                  Try again
                </button>
              </p>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
