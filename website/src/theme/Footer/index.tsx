import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
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
  {label: 'GitHub', href: 'https://github.com/lakshmaji/yv'},
  {label: 'Sponsor', href: 'https://github.com/sponsors/lakshmaji'},
];

export default function Footer(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <footer className={styles.footer}>
      <div className="container">
        {/* Decorative: the site name is already in the copyright line, and a
            screen reader does not need it twice. */}
        <div className={styles.wordmarkWrap} aria-hidden="true">
          <span className={styles.wordmark}>{siteConfig.title}</span>
        </div>

        <div className={styles.bar}>
          <span className={styles.copy}>© {new Date().getFullYear()} yv</span>

          <nav className={styles.links} aria-label="Footer">
            {LINKS.map((l) => (
              <Link key={l.label} className={styles.link} to={l.to} href={l.href}>
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
      </div>
    </footer>
  );
}
