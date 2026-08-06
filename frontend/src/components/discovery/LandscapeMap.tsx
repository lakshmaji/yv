import { For } from 'solid-js';
import { LAND } from '../../lib/landscape/palette';
import { ringPath, type World } from '../../lib/landscape/world';
import type { Dino } from '../../lib/dino';
import Dinosaur from './Dinosaur';
import Terrain from './Terrain';
import Water from './Water';
import Scenery from './Scenery';
import Trails from './Trails';
import Settlements from './Settlements';
import Clouds from './Clouds';

/**
 * The whole scene, drawn in painter's order: ocean, shelf, land, water bodies,
 * scenery (forest and mountains interleaved by depth), trails, settlements,
 * then atmosphere on top.
 *
 * One `viewBox` over the world's fixed 1600×900 space means every coordinate the
 * generator emits is resolution-independent — the panel can be any size and the
 * composition holds.
 */
export default function LandscapeMap(props: {
  world: World;
  dinos?: Dino[];
  onSelectDino?: (dino: Dino) => void;
}) {
  const coastPath = () => ringPath(props.world.coast);

  return (
    <svg
      class="landscape-svg"
      viewBox={`0 0 ${props.world.width} ${props.world.height}`}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label={`Procedurally generated world map, seed ${props.world.seed}`}
    >
      <defs>
        <linearGradient id="ocean-grad" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stop-color={LAND.waterMid} />
          <stop offset="55%" stop-color={LAND.waterDeep} />
          <stop offset="100%" stop-color="#061626" />
        </linearGradient>

        {/* stop-opacity, not rgba() in stop-color — the latter is a CSS-colour
            extension some SVG rasterisers ignore, which turns the vignette into
            an opaque black rectangle over the whole map. */}
        <radialGradient id="vignette-grad" cx="0.5" cy="0.5" r="0.72">
          <stop offset="55%" stop-color="#020a12" stop-opacity="0" />
          <stop offset="100%" stop-color="#020a12" stop-opacity="0.62" />
        </radialGradient>

        {/* Height cues. The island casts a long shadow onto the sea; terraces
            cast a short one onto the step below. */}
        <filter id="terrain-shadow" x="-20%" y="-20%" width="150%" height="150%">
          <feDropShadow dx="10" dy="16" stdDeviation="12" flood-color={LAND.shadow} flood-opacity="0.55" />
        </filter>
        <filter id="terrace-shadow" x="-20%" y="-20%" width="150%" height="150%">
          <feDropShadow dx="4" dy="7" stdDeviation="4" flood-color={LAND.shadow} flood-opacity="0.4" />
        </filter>
        <filter id="fog-blur" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="34" />
        </filter>
        <filter id="shelf-blur" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="18" />
        </filter>
        <filter id="swell-blur" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="26" />
        </filter>
      </defs>

      <rect x="0" y="0" width={props.world.width} height={props.world.height} fill="url(#ocean-grad)" />

      {/* Slow-drifting swells: the cheapest convincing "the sea is alive" cue. */}
      <g class="land-swells" filter="url(#swell-blur)">
        <ellipse class="land-swell swell-a" cx="380" cy="200" rx="420" ry="120" fill={LAND.waterShallow} opacity="0.1" />
        <ellipse class="land-swell swell-b" cx="1180" cy="700" rx="500" ry="150" fill={LAND.waterShallow} opacity="0.09" />
        <ellipse class="land-swell swell-c" cx="820" cy="460" rx="620" ry="200" fill={LAND.foam} opacity="0.05" />
      </g>

      {/* Shallow shelf ring around the island, then the breaking foam line. */}
      <path
        d={coastPath()}
        fill="none"
        stroke={LAND.waterShallow}
        stroke-width="70"
        opacity="0.5"
        filter="url(#shelf-blur)"
      />
      <path class="land-foam" d={coastPath()} fill="none" stroke={LAND.foam} stroke-width="5" opacity="0.45" />

      <Terrain world={props.world} />
      <Water world={props.world} />
      <Scenery world={props.world} />
      <Trails world={props.world} />
      {/* Above the trails so a dinosaur isn't crossed by a path, below the
          settlement labels so names stay readable. */}
      <For each={props.dinos ?? []}>
        {(dino) => <Dinosaur dino={dino} onSelect={props.onSelectDino} />}
      </For>
      <Settlements world={props.world} />
      <Clouds world={props.world} />

      <rect
        x="0"
        y="0"
        width={props.world.width}
        height={props.world.height}
        fill="url(#vignette-grad)"
        pointer-events="none"
      />
    </svg>
  );
}
