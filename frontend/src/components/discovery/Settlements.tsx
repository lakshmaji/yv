import { For } from 'solid-js';
import { LAND } from '../../lib/landscape/palette';
import { settlementShape } from '../../lib/landscape/shapes';
import type { World } from '../../lib/landscape/world';

/**
 * Huts, camps and ruins with their generated names. Labels are rendered with a
 * dark halo stroke under the fill so they stay legible over both grass and snow.
 */
export default function Settlements(props: { world: World }) {
  return (
    <g class="land-settlements">
      <For each={props.world.settlements}>
        {(s) => {
          const shape = settlementShape(s);
          return (
            <g class="land-settlement">
              <ellipse cx={s.x + 3} cy={s.y + 3} rx="14" ry="5" fill={LAND.shadow} opacity="0.32" />
              <path d={shape.body} fill={s.kind === 'ruin' ? LAND.ruin : LAND.hutWall} />
              {shape.roof && <path d={shape.roof} fill={LAND.hutRoof} />}
              <text class="land-label" x={s.x} y={s.y + 18} text-anchor="middle">
                {s.name}
              </text>
            </g>
          );
        }}
      </For>
    </g>
  );
}
