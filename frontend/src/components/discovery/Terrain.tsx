import { For } from 'solid-js';
import { LAND, biomeColor } from '../../lib/landscape/palette';
import { ringPath, type World } from '../../lib/landscape/world';

/**
 * The land itself: one base island, then each biome's blob with its terrace
 * steps stacked inside. Height is implied by the drop shadow on each step —
 * the same trick the reference render gets from real geometry.
 */
export default function Terrain(props: { world: World }) {
  return (
    <>
      <g class="land-island" filter="url(#terrain-shadow)">
        <path d={ringPath(props.world.coast)} fill={LAND.grassDark} />
        <For each={props.world.islets}>
          {(islet) => <path d={ringPath(islet)} fill={LAND.grassMid} />}
        </For>
      </g>

      {/* A slightly inset lighter fill reads as the shoreline bank. */}
      <path d={ringPath(props.world.coast)} fill={LAND.grassMid} opacity="0.9" />

      <For each={props.world.biomes}>
        {(biome) => (
          <g class="land-biome">
            <path d={ringPath(biome.region)} fill={biomeColor(biome.kind, 0)} />
            <For each={biome.terraces}>
              {(terrace, i) => (
                <path
                  d={ringPath(terrace)}
                  fill={biomeColor(biome.kind, i() + 1)}
                  filter="url(#terrace-shadow)"
                />
              )}
            </For>
          </g>
        )}
      </For>
    </>
  );
}
