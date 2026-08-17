import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {type: 'category', label: 'Overview', items: ['FEATURES']},
    {type: 'category', label: 'Getting Started', items: ['DEVELOPMENT']},
    {
      type: 'category',
      label: 'Guides',
      items: ['docs/yv-yaml', 'docs/environments'],
    },
    {type: 'category', label: 'Releasing', items: ['RELEASING']},
  ],
};

export default sidebars;
