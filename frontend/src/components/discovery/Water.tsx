import { For } from 'solid-js';
import { LAND } from '../../lib/landscape/palette';
import { linePath, ringPath, type World } from '../../lib/landscape/world';

/**
 * Rivers and lakes, drawn after the terrain so they cut into it.
 *
 * Each river is three stacked strokes — dark bed, body, then a dashed highlight
 * that the CSS animates along its length. Animating a dash offset costs one
 * compositor property per river; an SVG turbulence filter animated per frame
 * would look better and cost far more in the WebKit webview.
 */
export default function Water(props: { world: World }) {
  return (
    <>
      <For each={props.world.rivers}>
        {(river) => {
          const d = linePath(river.points);
          return (
            <g class="land-river">
              <path d={d} fill="none" stroke={LAND.shadow} stroke-width={river.width + 5} stroke-linecap="round" opacity="0.35" />
              <path d={d} fill="none" stroke={LAND.waterMid} stroke-width={river.width} stroke-linecap="round" />
              <path d={d} fill="none" stroke={LAND.waterShallow} stroke-width={river.width * 0.45} stroke-linecap="round" opacity="0.8" />
              <path
                class="land-river-glint"
                d={d}
                fill="none"
                stroke={LAND.foam}
                stroke-width={Math.max(1.5, river.width * 0.16)}
                stroke-linecap="round"
                stroke-dasharray="14 46"
              />
            </g>
          );
        }}
      </For>

      <For each={props.world.lakes}>
        {(lake) => (
          <g class="land-lake">
            <path d={ringPath(lake.ring)} fill={LAND.waterMid} stroke={LAND.shadow} stroke-width="2" opacity="0.95" />
            <ellipse
              cx={lake.center.x}
              cy={lake.center.y}
              rx={lake.radius * 0.55}
              ry={lake.radius * 0.36}
              fill={LAND.waterShallow}
              opacity="0.75"
            />
          </g>
        )}
      </For>
    </>
  );
}
