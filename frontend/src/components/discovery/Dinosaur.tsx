import { For, Show } from 'solid-js';
import { dinoShape, DINO_TEMPO, type Dino } from '../../lib/dino';
import { shade } from '../../lib/landscape/palette';

/**
 * One dinosaur, projected from the data `randomDino` returns.
 *
 * Draw order is what makes flat art like this read: far legs behind the body,
 * plates behind it too so only their tips show, then the silhouette, then belly,
 * spots, near legs and finally the face.
 *
 * The nesting exists for the animation. Each layer owns one transform, because a
 * single element can only run one at a time and CSS would otherwise have the
 * hover state fighting the idle loop:
 *
 *   .land-dino       hover — lift and scale
 *   .land-dino-bob   vertical breathing
 *   .land-dino-sway  rotation about the feet
 *   .land-dino-eye   blink
 *
 * Every cycle is scaled by the species tempo and offset by the animal's own
 * `phase`, so a herd never moves in unison — which is the point: distinct
 * rhythms are what let you pick one animal out at a glance.
 */
export default function Dinosaur(props: { dino: Dino }) {
  const shape = () => dinoShape(props.dino);
  const c = () => props.dino.colors;
  const legShade = () => shade(props.dino.colors.body, -0.18);
  const tempo = () => DINO_TEMPO[props.dino.species];

  return (
    <g
      class="land-dino"
      // The lift is a length, not a percentage: percentage translate resolves
      // against the transform-box, which is easy to get subtly wrong in SVG and
      // fails silently. A custom property keeps it exact and size-relative.
      style={{ '--dino-bob': `${(props.dino.size * 0.035).toFixed(2)}px` }}
    >
      <title>{props.dino.name}</title>

      {/* Outside the bob, so the shadow stays planted while the animal breathes.
          A shadow that rises with the body reads as the whole thing sliding. */}
      <ellipse
        cx={shape().shadow.cx}
        cy={shape().shadow.cy}
        rx={shape().shadow.rx}
        ry={shape().shadow.ry}
        fill="#04121e"
        opacity="0.22"
      />

      <g
        class="land-dino-bob"
        style={{
          'animation-duration': `${tempo().toFixed(2)}s`,
          'animation-delay': `${(-props.dino.phase * tempo()).toFixed(2)}s`,
        }}
      >
        <g
          class="land-dino-sway"
          style={{
            // Not a multiple of the bob, so the two never resynchronise into a
            // single obvious beat.
            'animation-duration': `${(tempo() * 1.7).toFixed(2)}s`,
            'animation-delay': `${(-props.dino.phase * tempo() * 1.7).toFixed(2)}s`,
          }}
        >
          <For each={shape().legsBack}>{(leg) => <path d={leg} fill={legShade()} />}</For>

          {/* Behind the body, so only the tips clear the back — as in the
              reference, where plates read as a fringe rather than fins. */}
          <For each={shape().plates}>{(plate) => <path d={plate} fill={c().plate} />}</For>
          <Show when={shape().frill}>
            {(frill) => <path d={frill()} fill={c().plate} />}
          </Show>

          <path d={shape().body} fill={c().body} />
          <path d={shape().belly} fill={c().belly} />
          <For each={shape().spots}>
            {(s) => <circle cx={s.cx} cy={s.cy} r={s.r} fill={c().spot} opacity="0.55" />}
          </For>

          <For each={shape().legsFront}>{(leg) => <path d={leg} fill={c().body} />}</For>
          <For each={shape().toes}>
            {(t) => <circle cx={t.cx} cy={t.cy} r={t.r} fill={c().claw} />}
          </For>

          <For each={shape().arms}>{(arm) => <path d={arm} fill={legShade()} />}</For>
          <For each={shape().horns}>{(horn) => <path d={horn} fill={c().claw} />}</For>

          <g
            class="land-dino-eye"
            style={{
              // Roughly every 3–4.5s depending on species. The first pass ran at
              // tempo * 1.9 — a blink every 6–10s, which is lifelike and, on an
              // eye a few pixels across, entirely invisible.
              'animation-duration': `${(tempo() * 0.85).toFixed(2)}s`,
              'animation-delay': `${(-props.dino.phase * tempo() * 3).toFixed(2)}s`,
            }}
          >
            <circle cx={shape().eye.cx} cy={shape().eye.cy} r={shape().eye.r} fill="#20222a" />
            <circle cx={shape().glint.cx} cy={shape().glint.cy} r={shape().glint.r} fill="#ffffff" />
          </g>

          <path
            d={shape().smile}
            fill="none"
            stroke="#20222a"
            stroke-width={Math.max(1, props.dino.size * 0.018)}
            stroke-linecap="round"
            opacity="0.75"
          />

          {/* Growl. Each arc fades in a beat after the one inside it, so the
              sound reads as travelling outward; they all rest together before
              the next call. Two strokes per arc — a dark halo under a light
              line — because a single colour disappears against either the pale
              grass or the dark water depending on where the animal stands. */}
          <For each={shape().growl}>
            {(arc, i) => (
              <g
                class="land-dino-growl"
                style={{
                  'animation-duration': `${(tempo() * 1.15).toFixed(2)}s`,
                  'animation-delay': `${(-props.dino.phase * tempo() + i() * 0.13).toFixed(2)}s`,
                }}
              >
                <path
                  d={arc}
                  fill="none"
                  stroke="rgba(4,18,30,.5)"
                  stroke-width={Math.max(2.2, props.dino.size * 0.05)}
                  stroke-linecap="round"
                />
                <path
                  d={arc}
                  fill="none"
                  stroke="#f4f8fb"
                  stroke-width={Math.max(1, props.dino.size * 0.026)}
                  stroke-linecap="round"
                />
              </g>
            )}
          </For>
        </g>
      </g>

      {/* Revealed on hover. <title> alone means waiting for a native tooltip;
          this names the animal the moment you point at it. */}
      <text
        class="land-dino-name"
        x={props.dino.x}
        y={props.dino.y - props.dino.size * 1.3}
        text-anchor="middle"
      >
        {props.dino.name}
      </text>
    </g>
  );
}
