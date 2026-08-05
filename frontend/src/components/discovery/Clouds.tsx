import { For } from 'solid-js';
import { LAND } from '../../lib/landscape/palette';
import type { World } from '../../lib/landscape/world';

/**
 * Drifting fog banks over the finished map. Each blob gets its own duration and
 * a negative delay, so on mount the sky is already mid-drift rather than every
 * cloud starting from the left edge together.
 */
export default function Clouds(props: { world: World }) {
  return (
    <g class="land-clouds" filter="url(#fog-blur)">
      <For each={props.world.clouds}>
        {(cloud) => (
          <ellipse
            class="land-cloud"
            cx={cloud.x}
            cy={cloud.y}
            rx={cloud.rx}
            ry={cloud.ry}
            fill={LAND.fog}
            opacity={cloud.opacity}
            style={{
              'animation-duration': `${cloud.duration.toFixed(1)}s`,
              'animation-delay': `${cloud.delay.toFixed(1)}s`,
            }}
          />
        )}
      </For>
    </g>
  );
}
