import { createMemo, For } from 'solid-js';
import { discoverySeed, setDiscoverySeed, discoveryMotion, setDiscoveryMotion } from '../store';
import { generateWorld, worldBiomeKinds } from '../lib/landscape/world';
import { BIOME_RAMPS, type BiomeKind } from '../lib/landscape/palette';
import LandscapeMap from './discovery/LandscapeMap';

const BIOME_LABELS: Record<BiomeKind, string> = {
  grass: 'Lowland',
  highland: 'Highland',
  redrock: 'Red canyon',
  snowfield: 'Snowfield',
};

export default function DiscoveryPanel() {
  // One memo is the whole regeneration mechanism: writing the seed rebuilds the
  // world, and Solid diffs the SVG for us.
  const world = createMemo(() => generateWorld(discoverySeed()));

  function reroll(): void {
    // Picking a seed is a user action, not generation — Math.random is fine
    // here, and never reaches the generator itself.
    setDiscoverySeed(Math.floor(Math.random() * 1_000_000_000));
  }

  return (
    <main id="main" class="discovery">
      <div id="dashboard-header">
        <div class="dash-heading">
          <span class="dash-title">Discovery</span>
          <span class="dash-subtitle">A procedurally generated world — every seed is a different island</span>
        </div>
      </div>

      <div class="dash-toolbar">
        <button type="button" class="dash-refresh" onClick={reroll}>
          ↻ Regenerate
        </button>

        <button
          type="button"
          class="dash-refresh"
          classList={{ active: discoveryMotion() }}
          title="Water shimmer, drifting fog and canopy sway"
          onClick={() => setDiscoveryMotion(!discoveryMotion())}
        >
          {discoveryMotion() ? '◉ Motion on' : '○ Motion off'}
        </button>

        <div class="disc-legend">
          <For each={worldBiomeKinds(world())}>
            {(kind) => (
              <span class="disc-legend-item">
                <span class="disc-swatch" style={{ background: BIOME_RAMPS[kind][2] }} />
                {BIOME_LABELS[kind]}
              </span>
            )}
          </For>
        </div>
      </div>

      <div class="landscape-stage" classList={{ 'no-motion': !discoveryMotion() }}>
        <LandscapeMap world={world()} />
        <div class="landscape-meta">
          {/* The seed is shown but not editable — it is here so a world you like
              can be noted down and asked for again, not as a control. */}
          <span>seed {world().seed}</span>
          <span>{world().trees.length} trees</span>
          <span>{world().peaks.length} peaks</span>
          <span>{world().settlements.length} settlements</span>
          <span>{world().rivers.length} waterways</span>
        </div>
      </div>
    </main>
  );
}
