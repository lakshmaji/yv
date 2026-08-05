import { createMemo, For } from 'solid-js';
import { discoverySeed, setDiscoverySeed, discoveryMotion, setDiscoveryMotion } from '../store';
import { generateWorld, openGround, worldBiomeKinds, WORLD_H, WORLD_W } from '../lib/landscape/world';
import { BIOME_RAMPS, type BiomeKind } from '../lib/landscape/palette';
import { randomDinos } from '../lib/dino';
import LandscapeMap from './discovery/LandscapeMap';

const BIOME_LABELS: Record<BiomeKind, string> = {
  grass: 'Lowland',
  highland: 'Highland',
  redrock: 'Red canyon',
  snowfield: 'Snowfield',
};

/**
 * The names this screen asks for. randomDino seeds from the name, so Rexy is
 * always the same animal — the world seed only decides where the herd stands.
 */
const DINO_NAMES = ['Rexy', 'Bronte', 'Spike', 'Trixie', 'Dot', 'Nessa'];

export default function DiscoveryPanel() {
  // One memo is the whole regeneration mechanism: writing the seed rebuilds the
  // world, and Solid diffs the SVG for us.
  const world = createMemo(() => generateWorld(discoverySeed()));

  // The dinosaur utility knows nothing about islands; it takes bounds and a
  // predicate, and finding it somewhere to stand is the caller's business.
  //
  // Sizes are deliberately modest: a tree is only ~15px tall and a summit 50–130,
  // so anything much past 70 stops reading as an animal in a landscape and starts
  // competing with the mountains.
  const dinos = createMemo(() =>
    randomDinos(DINO_NAMES, {
      bounds: { x: 60, y: 120, width: WORLD_W - 120, height: WORLD_H - 200 },
      allow: openGround(world(), 30),
      variant: world().seed,
      minSize: 44,
      maxSize: 72,
    }),
  );

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
        <LandscapeMap world={world()} dinos={dinos()} />
        <div class="landscape-meta">
          {/* The seed is shown but not editable — it is here so a world you like
              can be noted down and asked for again, not as a control. */}
          <span>seed {world().seed}</span>
          <span>{world().trees.length} trees</span>
          <span>{world().peaks.length} peaks</span>
          <span>{world().settlements.length} settlements</span>
          <span>{world().rivers.length} waterways</span>
          <span>{dinos().length} dinosaurs</span>
        </div>
      </div>
    </main>
  );
}
