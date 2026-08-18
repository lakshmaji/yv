import type {ReactNode} from 'react';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import BlobHero from '@site/src/components/BlobHero';

export default function Demo(): ReactNode {
  return (
    <Layout title="Demo" description="See yv in action">
      <BlobHero className="hero--primary">
        <Heading as="h1" className="hero__title">
          Demo
        </Heading>
        <p className="hero__subtitle">Coming soon.</p>
      </BlobHero>
    </Layout>
  );
}
