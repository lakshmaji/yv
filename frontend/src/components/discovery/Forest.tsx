import { For } from 'solid-js';
import { LAND } from '../../lib/landscape/palette';
import { treeShape } from '../../lib/landscape/shapes';
import type { World } from '../../lib/landscape/world';

/**
 * Conifer clusters. The per-tree negative animation-delay comes from the seeded
 * `sway` value, so the canopy breathes unevenly instead of pulsing as one block
 * — and it stays identical for a given seed.
 */
export default function Forest(props: { world: World }) {
  return (
    <g class="land-forest">
      <For each={props.world.trees}>
        {(tree) => {
          const shape = treeShape(tree);
          return (
            <g class="land-tree" style={{ 'animation-delay': `${(-tree.sway * 7).toFixed(2)}s` }}>
              <ellipse
                cx={tree.x + tree.size * 0.18}
                cy={tree.y + 1}
                rx={tree.size * 0.38}
                ry={tree.size * 0.14}
                fill={LAND.shadow}
                opacity="0.3"
              />
              <path d={shape.trunk} fill={LAND.trunk} />
              <path d={shape.canopyLower} fill={LAND.treeDark} />
              <path d={shape.canopyUpper} fill={LAND.treeMid} />
            </g>
          );
        }}
      </For>
    </g>
  );
}
