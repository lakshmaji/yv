import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

import styles from './styles.module.css';

/**
 * Replaces the classic theme's footer outright.
 *
 * The stock one is a grid of titled link columns over a dark slab. This keeps
 * the columns but hangs them off the things a visitor actually arrives here
 * looking for — the spec, the repo, a way to sponsor — and closes with an
 * oversized mark instead of a slab.
 *
 * Because this file exists, `themeConfig.footer` is not read by anything. It was
 * removed from the config rather than left behind to look load-bearing.
 */
const COLUMNS = [
  {
    title: 'Docs',
    links: [
      {label: 'Features', to: '/docs/FEATURES'},
      {label: 'The yv.yaml spec', to: '/docs/docs/yv-yaml'},
      {label: 'Environments', to: '/docs/docs/environments'},
      {label: 'Development', to: '/docs/DEVELOPMENT'},
    ],
  },
  {
    title: 'Project',
    links: [
      {label: 'Demo', to: '/demo'},
      {label: 'Releasing', to: '/docs/RELEASING'},
      {label: 'GitHub', href: 'https://github.com/lakshmaji/yv'},
      {label: 'Sponsor', href: 'https://github.com/sponsors/lakshmaji'},
    ],
  },
];

/**
 * The two links worth a glyph. They keep their labels: the navbar can afford an
 * icon-only GitHub link because it is one of five things in a bar, but down here
 * the row is the only thing pointing off-site.
 */
const SOCIAL = [
  {label: 'GitHub', href: 'https://github.com/lakshmaji/yv', glyph: styles.glyphGithub},
  {
    label: 'Sponsor',
    href: 'https://github.com/sponsors/lakshmaji',
    glyph: styles.glyphSponsor,
  },
];

export default function Footer(): ReactNode {
  const {siteConfig} = useDocusaurusContext();

  // The site is served under /yv/, so a bare /img path 404s once deployed.
  const icon = useBaseUrl('/img/logo.png');
  const wails = useBaseUrl('/img/wails.svg');
  const solid = useBaseUrl('/img/solidjs.svg');

  return (
    <footer className={styles.footer}>
      <div className="container">
        {/* Decorative: the site name is already in the copyright line, and a
            screen reader does not need it twice. */}
        <div className={styles.markRow} aria-hidden="true">
          <span className={styles.wordmark}>{siteConfig.title}</span>
        </div>

        <div className={styles.mid}>
          <nav className={styles.socialRow} aria-label="Project links">
            {SOCIAL.map((s) => (
              <Link key={s.label} className={styles.social} href={s.href}>
                <span className={`${styles.glyph} ${s.glyph}`} aria-hidden="true" />
                {s.label}
              </Link>
            ))}
          </nav>

          <Link className={styles.cta} to="/docs/FEATURES">
            <img className={styles.ctaIcon} src={icon} alt="" aria-hidden="true" />
            <span className={styles.ctaText}>Ready to run your project&apos;s commands?</span>
            <span className={styles.ctaButton}>Get started →</span>
          </Link>
        </div>

        <div className={styles.top}>
          <p className={styles.blurb}>{siteConfig.tagline}</p>

          {COLUMNS.map((col) => (
            <nav key={col.title} className={styles.col} aria-label={col.title}>
              <h2 className={styles.colTitle}>{col.title}</h2>
              {col.links.map((l) => (
                <Link key={l.label} className={styles.colLink} to={l.to} href={l.href}>
                  {l.label}
                </Link>
              ))}
            </nav>
          ))}
        </div>

        <div className={styles.caps}>
          <span>One file, every command</span>
          <span className={styles.made}>
            Made with
            {/* The marks carry the recognition; the link text carries the name,
                so the images are decorative. */}
            <img className={styles.madeLogo} src={wails} alt="" aria-hidden="true" />
            <Link className={styles.capsLink} href="https://wails.io">
              Wails
            </Link>
            and
            <img className={styles.madeLogo} src={solid} alt="" aria-hidden="true" />
            <Link className={styles.capsLink} href="https://solidjs.com">
              SolidJS
            </Link>
          </span>
        </div>

        <div className={styles.bar}>
          <span className={styles.copy}>© {new Date().getFullYear()} yv</span>
          <Link
            className={styles.licence}
            href="https://github.com/lakshmaji/yv/blob/main/LICENSE"
          >
            MIT License
          </Link>
        </div>
      </div>
    </footer>
  );
}
