import { For, Show } from 'solid-js';
import { GREY_ROCK, LAND, RED_ROCK, rockRamp } from '../../lib/landscape/palette';
import { peakShape } from '../../lib/landscape/shapes';
import type { Peak } from '../../lib/landscape/world';

/**
 * One mountain, built from flat facets.
 *
 * Draw order is the whole point: the silhouette goes down first in the darkest
 * tone so every facet gets a rock edge for free, then the two facets tile over
 * it, then the fold between them is stroked to sharpen it. Light comes from the
 * top-left, matching the island's own drop shadow.
 */
export default function PeakGlyph(props: { peak: Peak }) {
  const shape = () => peakShape(props.peak);
  const ramp = () => rockRamp(props.peak.red ? RED_ROCK : GREY_ROCK, props.peak.tone);

  return (
    <g class="land-peak">
      {/* Cast down-right, away from the light. Without a foot shadow the base
          line reads as the mountain having been cut off flush with the grass. */}
      <ellipse
        cx={shape().shadow.cx}
        cy={shape().shadow.cy}
        rx={shape().shadow.rx}
        ry={shape().shadow.ry}
        fill={LAND.shadow}
        opacity="0.2"
      />
      <For each={shape().scree}>
        {(s) => <circle cx={s.cx} cy={s.cy} r={s.r} fill={LAND.scree} opacity="0.7" />}
      </For>

      <path d={shape().body} fill={ramp().shade} />
      <path d={shape().shade} fill={ramp().mid} />
      <path d={shape().lit} fill={ramp().light} />

      {/* The facets tile the body exactly, so the silhouette needs its own edge
          to separate from the terrain behind — but only along the upper rim. */}
      <path d={shape().outline} fill="none" stroke={LAND.shadow} stroke-width="1.1" opacity="0.5" />
      <path d={shape().crease} fill="none" stroke={ramp().shade} stroke-width="1.2" opacity="0.55" />

      <Show when={shape().snow}>
        {(snow) => (
          <>
            <path d={snow()} fill={LAND.snow} />
            <Show when={shape().snowShade}>
              {(shaded) => <path d={shaded()} fill={LAND.snowShade} />}
            </Show>
          </>
        )}
      </Show>
    </g>
  );
}
