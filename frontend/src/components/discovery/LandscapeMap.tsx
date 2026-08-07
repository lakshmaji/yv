import { For, Show, createMemo } from 'solid-js';
import { LAND } from '../../lib/landscape/palette';
import { coastalSurf, coastalSwell, whitecaps } from '../../lib/landscape/sea';
import { seaLife } from '../../lib/landscape/sealife';
import { ringPath, type World } from '../../lib/landscape/world';
import type { Dino } from '../../lib/dino';
import type { Drone as DroneData } from '../../lib/drone';
import type { ChatBubble } from '../../lib/chatBubble';
import Dinosaur from './Dinosaur';
import Drone from './Drone';
import Terrain from './Terrain';
import Water from './Water';
import Scenery from './Scenery';
import Trails from './Trails';
import Settlements from './Settlements';
import Clouds from './Clouds';
import SeaLife from './SeaLife';

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
  drone?: DroneData;
  /** Devices found: the drone's lights go green. */
  droneLocked?: boolean;
  /** The sweep came up empty and the drone is going up in smoke. */
  droneBursting?: boolean;
  /**
   * What the drone is saying. Sized by the panel rather than here, because the
   * same bubble constrains where the drone is allowed to fly.
   */
  droneChat?: ChatBubble | null;
  /**
   * Whether ambient motion is on. Only the drone needs telling — everything else
   * is stopped by the `.no-motion` class on the stage, but the drone's travel is
   * a script animation, which CSS cannot reach.
   */
  motion?: boolean;
}) {
  const coastPath = () => ringPath(props.world.coast);
  const swell = createMemo(() => coastalSwell(props.world.coast, props.world.seed));
  const surf = createMemo(() => coastalSurf(props.world.coast, props.world.seed));
  const caps = createMemo(() =>
    whitecaps(
      props.world.coast,
      props.world.islets,
      props.world.width,
      props.world.height,
      props.world.seed,
    ),
  );
  const creatures = createMemo(() =>
    seaLife(
      props.world.coast,
      props.world.islets,
      props.world.width,
      props.world.height,
      props.world.seed,
    ),
  );

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

      {/* Swell rolling in, contracting onto the shore as it fades — so the sea
          travels towards the land instead of only shimmering in place.
          transform-origin is the coast's own centroid, the point the rings were
          offset from, so the contraction retraces the spacing between them.

          The animation sits on the group, not the arcs: a wave is broken into
          several crests but it is still one wave, and they have to come in
          together. */}
      <g class="land-swash">
        <For each={swell().waves}>
          {(w) => (
            <g
              class="land-wave"
              style={{
                'transform-origin': `${swell().origin.x.toFixed(2)}px ${swell().origin.y.toFixed(2)}px`,
                '--wave-to': w.to.toFixed(4),
                '--wave-dur': `${w.dur.toFixed(2)}s`,
                '--wave-delay': `${w.delay.toFixed(2)}s`,
              }}
            >
              <For each={w.arcs}>
                {(a) => (
                  <path
                    d={a.d}
                    fill="none"
                    stroke={LAND.foam}
                    stroke-width={a.strokeWidth}
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    opacity={a.opacity}
                  />
                )}
              </For>
            </g>
          )}
        </For>
      </g>

      {/* Whitecaps out on the open sea, so the water between the island and the frame
          is not empty space. Held within a few hundred px of the shore — the far
          corners of the reference are open water with nothing on them. */}
      <g class="land-caps">
        <For each={caps()}>
          {(c) => (
            <path
              class="land-cap"
              d={c.d}
              fill="none"
              stroke={LAND.surf}
              stroke-width={c.strokeWidth}
              stroke-linecap="round"
              opacity={c.opacity}
              style={{
                '--cap-dur': `${c.dur.toFixed(2)}s`,
                '--cap-delay': `${c.delay.toFixed(2)}s`,
                '--cap-peak': c.opacity.toFixed(3),
              }}
            />
          )}
        </For>
      </g>

      {/* The collar of broken water at the shore. A filled band, not a stroke: the
          inner edge is the shoreline exactly and the outer edge scallops, and that
          difference is what makes it spray instead of an outline. */}
      <Show when={surf()}>
        {(s) => (
          <path class="land-surf" d={s().d} fill={LAND.surf} opacity={s().opacity} />
        )}
      </Show>

      <path class="land-foam" d={coastPath()} fill="none" stroke={LAND.foam} stroke-width="5" opacity="0.45" />

      {/* Whales, dolphins and turtles. Above the swell and the caps, so an animal
          is not crossed by a crest, and below the island, which casts its shadow
          out over the water they are swimming in. `seaLife` keeps every one of
          them in open sea — outside the coast ring, which is also what puts them
          clear of the rivers and the lakes inside it. */}
      <SeaLife creatures={creatures()} motion={props.motion} />

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

      {/* Airborne, so it flies over the settlement labels — but under the fog,
          which is the only thing on the map above it. */}
      <Show when={props.drone}>
        {(drone) => (
          <Drone
            drone={drone()}
            locked={props.droneLocked ?? false}
            bursting={props.droneBursting}
            motion={props.motion}
            chat={props.droneChat}
          />
        )}
      </Show>

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
