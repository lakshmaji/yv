import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { seaShape, swimFrames, type SeaCreature } from '../../lib/landscape/sealife';
import { LAND } from '../../lib/landscape/palette';

/**
 * The animals in the water, projected from what `seaLife` returns.
 *
 * The nesting is the animation, as in Dinosaur.tsx and Drone.tsx — one transform
 * per layer, because an element can only run one at a time:
 *
 *   .land-sea-creature  the lap of the island   (JS, from the route data)
 *   .land-sea-leap      the porpoise: out of the water and back  (CSS)
 *   .land-sea-yaw       the body swinging about its own centre   (CSS)
 *   .land-sea-flex      the after-body, hinged at the shoulder   (CSS)
 *   .land-sea-fluke     the tail beat, pivoting at the peduncle  (CSS)
 *   .land-sea-fin       the flippers, pivoting at their roots    (CSS)
 *
 * Flex and fluke are nested and a quarter-beat apart, which is what makes the
 * body undulate rather than pulse: the wave starts at the shoulder and arrives
 * at the tail a moment later. One hinge alone is a tail wagging on a plank.
 *
 * The lap is driven by element.animate() for the same reason the drone's patrol
 * is: the stops are data, and a static keyframe rule could only reach them
 * through custom properties. The trade-off is the same too — neither `.no-motion`
 * nor the reduced-motion query can cancel a script animation, so both are honoured
 * here, and with the animation absent each animal sits at the first stop of its
 * circuit, which is why the route is offsets from a drawn position.
 *
 * The circuit is guaranteed to stay in open water by `seaLife`, which tests the
 * drawn hull at every stop with the animal pointing the way it will be pointing
 * there. Nothing about the animation can put one on the beach.
 */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(REDUCED_MOTION).matches === true;
}

/**
 * How far through the current leg of its lap the animal starts.
 *
 * A leaper's lap is geared so that one leg is one leap; this is what keeps the
 * two in step, since the lap's own phase covers the whole circuit.
 */
function legPhase(c: SeaCreature): number {
  const legs = Math.max(1, c.route.length - 1);
  return (c.phase * legs) % 1;
}

export default function SeaLife(props: { creatures: SeaCreature[]; motion?: boolean }) {
  // The OS setting can change while the app is open, and this is the only motion
  // in the water that CSS cannot switch off for us.
  const [reduced, setReduced] = createSignal(prefersReducedMotion());
  onMount(() => {
    const query = window.matchMedia?.(REDUCED_MOTION);
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    onCleanup(() => query.removeEventListener('change', onChange));
  });

  const swimming = () => props.motion !== false && !reduced();

  return (
    <g class="land-sealife">
      <For each={props.creatures}>
        {(creature) => {
          const shape = () => seaShape(creature);
          const c = creature.colors;
          const origin = `${creature.x.toFixed(2)}px ${creature.y.toFixed(2)}px`;
          const pivot = (p: { x: number; y: number }) =>
            `${p.x.toFixed(2)}px ${p.y.toFixed(2)}px`;

          let swimRef!: SVGGElement;
          let lap: Animation | undefined;

          createEffect(() => {
            lap?.cancel();
            lap = undefined;
            if (!swimming() || typeof swimRef.animate !== 'function') return;
            const frames = swimFrames(creature);
            if (frames.length < 2) return;
            lap = swimRef.animate(frames as unknown as Keyframe[], {
              duration: creature.dur * 1000,
              iterations: Infinity,
              easing: 'linear',
              // Its own point of the lap, so a pod does not swim in formation.
              delay: -creature.dur * creature.phase * 1000,
            });
          });

          onCleanup(() => lap?.cancel());

          return (
            <g
              class="land-sea-creature"
              ref={swimRef}
              style={{
                // The lap turns the animal as it goes, about the point it is
                // drawn at — not about the frame's origin, which is where an
                // unset transform-origin would pivot it.
                'transform-origin': origin,
                '--beat': `${creature.beat.toFixed(2)}s`,
                '--leap': `${(creature.leap || 1).toFixed(2)}s`,
                // Aligned to where the animal is within the current leg of its
                // lap, not to the lap as a whole — one leg is one leap, and the
                // arc has to happen during that leg's surge rather than at some
                // fixed point of a circuit it is already part-way round.
                '--leap-delay': `${(-(creature.leap || 1) * legPhase(creature)).toFixed(2)}s`,
                '--beat-delay': `${(-creature.beat * creature.phase).toFixed(2)}s`,
              }}
            >
              <title>{creature.kind}</title>

              {/* The water it is disturbing. A still patch of lifted tone with a
                  wake trailing astern — and astern only. Rings all the way round
                  an animal that is barely moving read as a heartbeat, because a
                  symmetric pulse says nothing about which way it is going.

                  Outside the yaw, so the disturbance stays where it was made
                  rather than swinging with the body that made it. */}
              <ellipse
                cx={shape().ripple.cx}
                cy={shape().ripple.cy}
                rx={shape().ripple.rx}
                ry={shape().ripple.ry}
                transform={`rotate(${shape().ripple.angle.toFixed(2)} ${shape().ripple.cx.toFixed(2)} ${shape().ripple.cy.toFixed(2)})`}
                fill={LAND.foam}
                opacity="0.06"
              />
              <For each={shape().wake}>
                {(d, i) => (
                  <path
                    class="land-sea-wake"
                    d={d}
                    fill="none"
                    stroke={LAND.foam}
                    stroke-width={creature.size * 0.07}
                    stroke-linecap="round"
                    style={{
                      // Scaled about the animal, not about the arc's own box:
                      // the wake is going out from the body, and fill-box would
                      // grow each arc where it happens to sit.
                      'transform-origin': origin,
                      '--wake-offset': i() / shape().wake.length,
                    }}
                  />
                )}
              </For>

              {/* The ring the body drops back through, under everything it is
                  dropping past. */}
              <Show when={shape().splash}>
                {(sp) => (
                  <ellipse
                    class="land-sea-splash"
                    cx={sp().ring.cx}
                    cy={sp().ring.cy}
                    rx={sp().ring.rx}
                    ry={sp().ring.ry}
                    transform={`rotate(${sp().ring.angle.toFixed(2)} ${sp().ring.cx.toFixed(2)} ${sp().ring.cy.toFixed(2)})`}
                    fill="none"
                    stroke={LAND.surf}
                    stroke-width={creature.size * 0.1}
                  />
                )}
              </Show>

              {/* Cast on the water while it is up in the air. From directly above
                  a leap has no height to show, so the shadow parting company with
                  the animal is the whole cue — that and the splash when it lands. */}
              <Show when={shape().airShadow}>
                {(sh) => (
                  <ellipse
                    class="land-sea-air-shadow"
                    cx={sh().cx}
                    cy={sh().cy}
                    rx={sh().rx}
                    ry={sh().ry}
                    transform={`rotate(${sh().angle.toFixed(2)} ${sh().cx.toFixed(2)} ${sh().cy.toFixed(2)})`}
                    fill="#04121e"
                  />
                )}
              </Show>

              {/* The porpoise. Its own layer between the lap and the yaw: the
                  animal grows as it clears the water and settles back, which is
                  what rising toward the viewer looks like from overhead. */}
              <g
                class="land-sea-leap"
                classList={{ leaping: creature.leap > 0 }}
                style={{ 'transform-origin': origin }}
              >
              <g class="land-sea-yaw" style={{ 'transform-origin': origin }}>
                {/* Fluke first: it is behind the body, and the join has to be
                    covered or the beat shows a seam at the peduncle. */}
                <g
                  class="land-sea-flex"
                  style={{ 'transform-origin': pivot(shape().flexPivot) }}
                >
                  <Show when={shape().fluke}>
                    {(d) => (
                      <path
                        class="land-sea-fluke"
                        d={d()}
                        fill={c.dark}
                        style={{ 'transform-origin': pivot(shape().flukePivot) }}
                      />
                    )}
                  </Show>
                  {/* The after-body over the fluke's root and under the forebody:
                      both joins are covered, so a swinging tail shows no seam. */}
                  <Show when={shape().flex}>{(d) => <path d={d()} fill={c.body} />}</Show>
                </g>

                {/* Limbs, behind the body for the same reason. The front pair
                    beat; a turtle's rear pair trail, which is what they do. */}
                <For each={shape().fins}>
                  {(fin) => (
                    <path
                      class="land-sea-fin"
                      classList={{ trailing: fin.trailing }}
                      d={fin.d}
                      fill={c.dark}
                      style={{
                        'transform-origin': pivot(fin.pivot),
                        // A mirrored pair strokes outward together rather than
                        // both swinging the same way, which would row the animal
                        // sideways.
                        '--fin-dir': fin.dir,
                        '--fin-amp': `${fin.amp}deg`,
                      }}
                    />
                  )}
                </For>

                <path d={shape().body} fill={c.body} />

                {/* Shell over the body, plates over the shell: a carapace is the
                    turtle's whole silhouette, so it is drawn last of the solids. */}
                <Show when={shape().shell}>
                  {(d) => <path d={d()} fill={c.body} stroke={c.dark} stroke-width={creature.size * 0.05} />}
                </Show>
                <For each={shape().plates}>
                  {(d) => <path d={d} fill={c.light} opacity="0.5" />}
                </For>

                <Show when={shape().head}>{(d) => <path d={d()} fill={c.skin} />}</Show>
                <Show when={shape().tail}>{(d) => <path d={d()} fill={c.skin} />}</Show>
                <Show when={shape().dorsal}>{(d) => <path d={d()} fill={c.dark} />}</Show>

                {/* Lit back. Offset toward the light, like the lake highlights. */}
                <ellipse
                  cx={shape().gloss.cx}
                  cy={shape().gloss.cy}
                  rx={shape().gloss.rx}
                  ry={shape().gloss.ry}
                  transform={`rotate(${shape().gloss.angle.toFixed(2)} ${shape().gloss.cx.toFixed(2)} ${shape().gloss.cy.toFixed(2)})`}
                  fill={c.light}
                  opacity="0.28"
                />

                <For each={shape().eyes}>
                  {(eye) => <circle cx={eye.cx} cy={eye.cy} r={eye.r} fill="#0d1b26" />}
                </For>
              </g>
              </g>

              {/* Re-entry, in two parts. The droplets are thrown up and go over
                  the animal; the ring is water at the surface and goes under it —
                  drawn together they would put a hoop around the dolphin. Both
                  sit outside the leap layer, which is busy scaling the body. */}
              <Show when={shape().splash}>
                {(sp) => (
                  <For each={sp().drops}>
                    {(drop) => (
                      <circle
                        class="land-sea-splash"
                        cx={drop.cx}
                        cy={drop.cy}
                        r={drop.r}
                        fill={LAND.surf}
                      />
                    )}
                  </For>
                )}
              </Show>

              {/* The blow, as the ring of spray it makes from above. Outside the
                  yaw so the spray hangs where it was thrown rather than swinging
                  with the animal under it. */}
              <Show when={shape().spout}>
                {(blow) => (
                  <circle
                    class="land-sea-spout"
                    cx={blow().cx}
                    cy={blow().cy}
                    r={blow().r}
                    fill="none"
                    stroke={LAND.surf}
                    stroke-width={creature.size * 0.09}
                  />
                )}
              </Show>
            </g>
          );
        }}
      </For>
    </g>
  );
}
