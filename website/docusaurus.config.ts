import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const baseUrl = '/yv/';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'yv',
  tagline: 'A specification for the commands a project runs, and the app that runs them.',
  // Rendered from img/logo.svg, so the tab and the navbar carry one mark.
  favicon: 'img/favicon.png',

  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  url: 'https://lakshmaji.github.io',
  baseUrl,

  organizationName: 'lakshmaji',
  projectName: 'yv',

  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: '../',
          routeBasePath: 'docs',
          include: [
            'FEATURES.md',
            'DEVELOPMENT.md',
            'RELEASING.md',
            'docs/yv-yaml.md',
            'docs/environments.md',
          ],
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/lakshmaji/yv/edit/main/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    // The app icon, which is far too fine-grained to survive in a navbar but
    // is exactly right at card size.
    image: 'img/social-card.jpg',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      // No `title`: the mark stands on its own in the corner. It is the app
      // icon's low-poly boar redrawn with fewer, thicker edges — the icon
      // itself is a fine wireframe over a nebula and dissolves below ~64px.
      logo: {
        alt: 'yv',
        src: 'img/logo.svg',
      },
      items: [
        {
          to: '/',
          label: 'yv',
          position: 'left',
          // Without this the item is active on every page: Docusaurus marks a
          // link active when the path starts with its target, and '/' resolves
          // to the base URL, which prefixes the whole site.
          activeBaseRegex: `^${baseUrl}?$`,
        },
        {to: '/docs/FEATURES', label: 'Docs', position: 'left'},
        {to: '/demo', label: 'Demo', position: 'left'},
        {
          href: 'https://github.com/sponsors/lakshmaji',
          label: 'Sponsor',
          position: 'right',
          className: 'navbar-sponsor',
        },
        {
          href: 'https://github.com/lakshmaji/yv',
          position: 'right',
          className: 'navbar-github',
          'aria-label': 'yv on GitHub',
        },
      ],
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
