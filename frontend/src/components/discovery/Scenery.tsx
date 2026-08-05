import { createMemo, For, Show } from 'solid-js';
import { sceneryOrder, type World } from '../../lib/landscape/world';
import TreeGlyph from './Forest';
import PeakGlyph from './Peaks';

/**
 * Trees and mountains in one back-to-front pass.
 *
 * Drawing every peak after every tree put each mountain in front of the whole
 * forest, including the trees standing downhill of it. Interleaving by depth
 * makes a summit sit *in* its treeline instead of pasted over it.
 */
export default function Scenery(props: { world: World }) {
  const order = createMemo(() => sceneryOrder(props.world));

  return (
    <g class="land-scenery">
      <For each={order()}>
        {(item) => (
          <Show
            when={item.kind === 'peak'}
            fallback={<TreeGlyph tree={props.world.trees[item.index]} />}
          >
            <PeakGlyph peak={props.world.peaks[item.index]} />
          </Show>
        )}
      </For>
    </g>
  );
}
