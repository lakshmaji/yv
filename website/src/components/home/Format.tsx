import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';

import styles from './Format.module.css';

/** Deliberately a fraction of docs/examples/yv.yaml — the docs hold the full field list. */
const SAMPLE = `id: checkout-api
name: Checkout API

groups:
  - Docker
  - Test

commands:
  - id: checkout-api-up
    label: Start stack
    command: docker compose up -d
    group: Docker

  - id: checkout-api-unit
    label: Unit tests
    command: go test ./... -short
    group: Test
`;

export default function Format(): ReactNode {
  return (
    <section className={styles.format}>
      <div className={`container ${styles.grid}`}>
        <div>
          <Heading as="h2">The commands live with the code</Heading>
          <p>
            A <code>yv.yaml</code> committed beside your source tells every machine that
            clones the repo what its commands are — the way a <code>Makefile</code> or a{' '}
            <code>package.json</code> scripts block does. yv finds it, shows you every
            command in it, and never runs anything until you press Run.
          </p>
          <p>
            <Link to="/docs/docs/yv-yaml">Read the specification →</Link>
          </p>
        </div>
        <CodeBlock language="yaml" title="yv.yaml">
          {SAMPLE}
        </CodeBlock>
      </div>
    </section>
  );
}
