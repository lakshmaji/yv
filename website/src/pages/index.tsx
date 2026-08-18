import type {ReactNode} from 'react';
import Layout from '@theme/Layout';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

import Hero from '@site/src/components/home/Hero';
import Features from '@site/src/components/home/Features';
import Format from '@site/src/components/home/Format';
import Showcase from '@site/src/components/home/Showcase';

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <Hero />
      <main>
        <Features />
        <Showcase />
        <Format />
      </main>
    </Layout>
  );
}
