import { For } from 'solid-js';
import { LAND } from '../../lib/landscape/palette';
import { linePath, type World } from '../../lib/landscape/world';

/** Winding paths between settlements: a dark casing under a pale dashed track. */
export default function Trails(props: { world: World }) {
  return (
    <g class="land-trails">
      <For each={props.world.trails}>
        {(trail) => {
          const d = linePath(trail);
          return (
            <>
              <path d={d} fill="none" stroke={LAND.shadow} stroke-width="6" stroke-linecap="round" opacity="0.2" />
              <path
                d={d}
                fill="none"
                stroke={LAND.trail}
                stroke-width="3"
                stroke-linecap="round"
                stroke-dasharray="9 6"
                opacity="0.85"
              />
            </>
          );
        }}
      </For>
    </g>
  );
}
