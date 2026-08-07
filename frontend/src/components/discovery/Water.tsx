import { For, Show, createMemo } from 'solid-js';
import { LAND, shade } from '../../lib/landscape/palette';
import { riverRibbon } from '../../lib/landscape/river';
import { ringPath, type World } from '../../lib/landscape/world';

/**
 * Rivers and lakes, drawn after the terrain so they cut into it.
 *
 * Each river is a filled variable-width ribbon rather than a stroke: a stroke has a
 * single width, which gives two exactly parallel banks and a channel that reads as a
 * pipe — or, with a dash marching down the middle of it, as a road. The geometry all
 * lives in lib/landscape/river.ts; this file only paints it.
 *
 * Layered by role, not by river. Every casing goes down first, then every channel,
 * then the shoals, then the streaks — because a tributary drawn as a complete unit
 * would lay its dark casing straight across the trunk that was already finished, and
 * a confluence would come out with a seam through it.
 */
export default function Water(props: { world: World }) {
  const ribbons = createMemo(() => props.world.rivers.map(riverRibbon));
  const bankTone = shade(LAND.waterMid, -0.4);

  return (
    <>
      {/* Cut banks. */}
      <For each={ribbons()}>
        {(r) => (
          <Show
            when={r.fallback}
            fallback={<path d={r.bank} fill={bankTone} opacity="0.75" />}
            keyed
          >
            {(f) => (
              <path
                d={f.d}
                fill="none"
                stroke={bankTone}
                stroke-width={f.width + 5}
                stroke-linecap="round"
                opacity="0.75"
              />
            )}
          </Show>
        )}
      </For>

      {/* Channels. */}
      <For each={ribbons()}>
        {(r) => (
          <Show
            when={r.fallback}
            fallback={<path d={r.body} fill={LAND.waterMid} />}
            keyed
          >
            {(f) => (
              <path
                d={f.d}
                fill="none"
                stroke={LAND.waterMid}
                stroke-width={f.width}
                stroke-linecap="round"
              />
            )}
          </Show>
        )}
      </For>

      {/* Lit shallow edge, sliding bank to bank as the course turns. */}
      <For each={ribbons()}>
        {(r) => (
          <Show when={!r.fallback}>
            <path class="land-river-shoal" d={r.shoal} fill={LAND.waterShallow} opacity="0.55" />
          </Show>
        )}
      </For>

      {/* Current. Streamlines running the length of the channel, with a glint
          travelling along each, then short ripples drifting across them. */}
      <For each={ribbons()}>
        {(r) => (
          <For each={r.streaks}>
            {(s) => (
              <path
                class={s.kind === 'thread' ? 'land-river-thread' : 'land-river-streak'}
                d={s.d}
                fill="none"
                stroke={LAND.foam}
                stroke-width={s.width}
                stroke-linecap="round"
                stroke-dasharray={s.dash || undefined}
                opacity={s.opacity}
                style={{
                  '--flow-dx': `${s.dx.toFixed(2)}px`,
                  '--flow-dy': `${s.dy.toFixed(2)}px`,
                  '--flow-dur': `${s.dur.toFixed(2)}s`,
                  '--flow-delay': `${s.delay.toFixed(2)}s`,
                  '--flow-travel': `${s.travel.toFixed(2)}`,
                }}
              />
            )}
          </For>
        )}
      </For>

      <For each={props.world.lakes}>
        {(lake) => (
          <g class="land-lake">
            <path d={ringPath(lake.ring)} fill={LAND.waterMid} stroke={LAND.shadow} stroke-width="2" opacity="0.95" />
            {/* The far rim in shadow, then the highlight offset toward the light —
                the map is lit from the top-left, and a highlight centred on the
                basin was the one feature ignoring it. The shadow is what actually
                reads as depth; without it the highlight looks like a sticker. */}
            <ellipse
              cx={lake.center.x + lake.radius * 0.14}
              cy={lake.center.y + lake.radius * 0.16}
              rx={lake.radius * 0.62}
              ry={lake.radius * 0.4}
              fill={LAND.shadow}
              opacity="0.25"
            />
            <ellipse
              cx={lake.center.x - lake.radius * 0.18}
              cy={lake.center.y - lake.radius * 0.22}
              rx={lake.radius * 0.5}
              ry={lake.radius * 0.32}
              fill={LAND.waterShallow}
              opacity="0.75"
            />
          </g>
        )}
      </For>
    </>
  );
}
