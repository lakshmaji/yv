import type {ReactNode} from 'react';
import Heading from '@theme/Heading';

import styles from './Features.module.css';

const FEATURES = [
  {
    title: 'Commands you can commit',
    body: 'Groups of shell commands described in one file, versioned with the repository. Pull a colleague’s change and your list updates — including the commands they removed.',
  },
  {
    title: 'Real terminals, not log tails',
    body: 'Every command runs in its own PTY and streams into its own row. Interactive prompts, colour and stdin all work, and pre/post commands run around it.',
  },
  {
    title: 'Devices that find each other',
    body: 'Machines on the same network discover each other over mDNS and can share configuration or files. Nothing transfers until you accept it.',
  },
];

export default function Features(): ReactNode {
  return (
    <section className={styles.features}>
      <div className={`container ${styles.grid}`}>
        {FEATURES.map((f) => (
          <div key={f.title} className={styles.card}>
            <Heading as="h3">{f.title}</Heading>
            <p>{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
