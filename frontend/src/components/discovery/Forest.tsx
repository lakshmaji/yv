import { LAND } from '../../lib/landscape/palette';
import { treeShape } from '../../lib/landscape/shapes';
import type { Tree } from '../../lib/landscape/world';

/**
 * One conifer. The negative animation-delay comes from the seeded `sway` value,
 * so the canopy breathes unevenly instead of pulsing as one block — and stays
 * identical for a given seed.
 */
export default function TreeGlyph(props: { tree: Tree }) {
  const shape = () => treeShape(props.tree);

  return (
    <g class="land-tree" style={{ 'animation-delay': `${(-props.tree.sway * 7).toFixed(2)}s` }}>
      <ellipse
        cx={props.tree.x + props.tree.size * 0.18}
        cy={props.tree.y + 1}
        rx={props.tree.size * 0.38}
        ry={props.tree.size * 0.14}
        fill={LAND.shadow}
        opacity="0.3"
      />
      <path d={shape().trunk} fill={LAND.trunk} />
      <path d={shape().canopyLower} fill={LAND.treeDark} />
      <path d={shape().canopyUpper} fill={LAND.treeMid} />
    </g>
  );
}
