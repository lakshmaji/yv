import type {ReactNode} from 'react';
import Layout from '@theme/Layout';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

import BlobHero from '@site/src/components/BlobHero';
import AnimatedWordmark from '@site/src/components/home/AnimatedWordmark';
import Showcase from '@site/src/components/home/Showcase';

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <BlobHero>
        <AnimatedWordmark text={siteConfig.title} />
        <p className="hero__subtitle">{siteConfig.tagline}</p>
      </BlobHero>
      <main>
        <Showcase />
      </main>
    </Layout>
  );
}
