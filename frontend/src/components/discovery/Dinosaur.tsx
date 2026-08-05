import { For, Show } from 'solid-js';
import { dinoShape, type Dino } from '../../lib/dino';
import { shade } from '../../lib/landscape/palette';

/**
 * One dinosaur, projected from the data `randomDino` returns.
 *
 * Draw order is what makes flat art like this read: far legs behind the body,
 * plates behind it too so only their tips show, then the silhouette, then belly,
 * spots, near legs and finally the face. The idle bob is staggered by the
 * creature's own `phase`, so a herd doesn't breathe in unison.
 */
export default function Dinosaur(props: { dino: Dino }) {
  const shape = () => dinoShape(props.dino);
  const c = () => props.dino.colors;
  const legShade = () => shade(props.dino.colors.body, -0.18);

  return (
    <g
      class="land-dino"
      style={{ 'animation-delay': `${(-props.dino.phase * 4).toFixed(2)}s` }}
    >
      <title>{props.dino.name}</title>

      <ellipse
        cx={shape().shadow.cx}
        cy={shape().shadow.cy}
        rx={shape().shadow.rx}
        ry={shape().shadow.ry}
        fill="#04121e"
        opacity="0.22"
      />

      <For each={shape().legsBack}>{(leg) => <path d={leg} fill={legShade()} />}</For>

      {/* Behind the body, so only the tips clear the back — as in the reference,
          where plates read as a fringe rather than as fins stuck on top. */}
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

      <circle cx={shape().eye.cx} cy={shape().eye.cy} r={shape().eye.r} fill="#20222a" />
      <circle cx={shape().glint.cx} cy={shape().glint.cy} r={shape().glint.r} fill="#ffffff" />
      <path
        d={shape().smile}
        fill="none"
        stroke="#20222a"
        stroke-width={Math.max(1, props.dino.size * 0.018)}
        stroke-linecap="round"
        opacity="0.75"
      />
    </g>
  );
}
