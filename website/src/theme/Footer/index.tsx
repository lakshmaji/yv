import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

import styles from './styles.module.css';

/**
 * Replaces the classic theme's footer outright.
 *
 * The stock one is a grid of titled link columns over a dark slab, which is a
 * lot of furniture for a site with five destinations. This is the whole thing in
 * one line — copyright, links, licence — under an oversized wordmark.
 *
 * Because this file exists, `themeConfig.footer` is not read by anything. It was
 * removed from the config rather than left behind to look load-bearing.
 */
const LINKS = [
  {label: 'Docs', to: '/docs/FEATURES'},
  {label: 'yv.yaml', to: '/docs/docs/yv-yaml'},
  {label: 'Demo', to: '/demo'},
];

/**
 * The two links worth a glyph. They keep their labels: the navbar can afford an
 * icon-only GitHub link because it is one of five things in a bar, but down here
 * the row is the only thing pointing off-site.
 */
const SOCIAL = [
  {label: 'GitHub', href: 'https://github.com/lakshmaji/yv', chip: styles.chipGithub},
  {
    label: 'Sponsor',
    href: 'https://github.com/sponsors/lakshmaji',
    chip: styles.chipSponsor,
  },
];

export default function Footer(): ReactNode {
  const {siteConfig} = useDocusaurusContext();

  // The site is served under /yv/, so a bare /img path 404s once deployed.
  const wails = useBaseUrl('/img/wails.svg');
  const solid = useBaseUrl('/img/solidjs.svg');

  return (
    <footer className={styles.footer}>
      <div className="container">
        {/* Decorative: the site name is already in the copyright line, and a
            screen reader does not need it twice. */}
        <div className={styles.wordmarkWrap} aria-hidden="true">
          <span className={styles.wordmark}>{siteConfig.title}</span>
        </div>

        <div className={styles.bar}>
          <div className={styles.about}>
            <span className={styles.copy}>© {new Date().getFullYear()} yv</span>
            <span className={styles.made}>
              Made with
              {/* The marks carry the recognition; the link text carries the
                  name, so the images are decorative. */}
              <img className={styles.madeLogo} src={wails} alt="" aria-hidden="true" />
              <Link className={styles.link} href="https://wails.io">
                Wails
              </Link>
              and
              <img className={styles.madeLogo} src={solid} alt="" aria-hidden="true" />
              <Link className={styles.link} href="https://solidjs.com">
                SolidJS
              </Link>
            </span>
          </div>

          <nav className={styles.links} aria-label="Footer">
            {LINKS.map((l) => (
              <Link key={l.label} className={styles.link} to={l.to}>
                {l.label}
              </Link>
            ))}
          </nav>

          <Link
            className={styles.licence}
            href="https://github.com/lakshmaji/yv/blob/main/LICENSE"
          >
            MIT License
          </Link>
        </div>

        <nav className={styles.socialRow} aria-label="Project links">
          {SOCIAL.map((s) => (
            <Link key={s.label} className={styles.social} href={s.href}>
              <span className={`${styles.chip} ${s.chip}`} aria-hidden="true" />
              {s.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
