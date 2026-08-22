import type {ReactNode} from 'react';
import Layout from '@theme/Layout';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

import Hero from '@site/src/components/home/Hero';
import Download from '@site/src/components/home/Download';
import Features from '@site/src/components/home/Features';
import Format from '@site/src/components/home/Format';
import Showcase from '@site/src/components/home/Showcase';

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    // The navbar is a sibling above this wrapper, so it reads the class with
    // `:has()` (see custom.css) to know it is sitting over the hero. A class on
    // <html> via <Head> would be simpler and is wrong: react-helmet does not
    // take it back off on client-side navigation, so every page reached from
    // here inherits the transparent bar.
    <Layout
      title={siteConfig.title}
      description={siteConfig.tagline}
      wrapperClassName="yv-home">
      <Hero />
      <main>
        <Download />
        <Features />
        <Showcase />
        <Format />
      </main>
    </Layout>
  );
}
