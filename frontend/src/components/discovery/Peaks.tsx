import { For } from 'solid-js';
import { LAND } from '../../lib/landscape/palette';
import { peakShape } from '../../lib/landscape/shapes';
import type { World } from '../../lib/landscape/world';

/** Rocky spires, flat-facetted rather than gradient-shaded. */
export default function Peaks(props: { world: World }) {
  return (
    <g class="land-peaks">
      <For each={props.world.peaks}>
        {(peak) => {
          const shape = peakShape(peak);
          // Red rock lives on the right of the map; tint accordingly so the
          // canyon region stays visually distinct from the grey highlands.
          const red = peak.x > props.world.width * 0.62 && !peak.snow;
          const mid = red ? LAND.redMid : LAND.rockMid;
          const light = red ? LAND.redLight : LAND.rockLight;
          return (
            <g class="land-peak">
              <path d={shape.base} fill={LAND.shadow} opacity="0.32" />
              <path d={shape.body} fill={mid} />
              <path d={shape.lit} fill={light} />
              {shape.snow && <path d={shape.snow} fill={LAND.snow} />}
            </g>
          );
        }}
      </For>
    </g>
  );
}
