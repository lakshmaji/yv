import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'yv',
  tagline: 'A specification for the commands a project runs, and the app that runs them.',
  favicon: 'img/favicon.ico',

  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  url: 'https://lakshmaji.github.io',
  baseUrl: '/yv/',

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
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'yv',
      items: [
        {to: '/', label: 'Home', position: 'left'},
        {to: '/docs/FEATURES', label: 'Docs', position: 'left'},
        {to: '/demo', label: 'Demo', position: 'left'},
        {
          href: 'https://github.com/sponsors/lakshmaji',
          label: 'Sponsor',
          position: 'right',
        },
        {
          href: 'https://github.com/lakshmaji/yv',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Features', to: '/docs/FEATURES'},
            {label: 'Development setup', to: '/docs/DEVELOPMENT'},
            {label: 'yv.yaml format', to: '/docs/docs/yv-yaml'},
          ],
        },
        {
          title: 'More',
          items: [
            {label: 'GitHub', href: 'https://github.com/lakshmaji/yv'},
            {label: 'Sponsor', href: 'https://github.com/sponsors/lakshmaji'},
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Lakshmaji Mutyala. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
