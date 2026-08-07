import { createEffect, createMemo, createSignal, onCleanup, onMount, For, Show } from 'solid-js';
import { bankFrames, burstShards, patrolFrames, type Drone as DroneData } from '../../lib/drone';
import type { ChatBubble } from '../../lib/chatBubble';
import { LAND } from '../../lib/landscape/palette';
import DroneGlyph from './DroneGlyph';

/**
 * A drone in flight: the airframe from DroneGlyph, plus everything about being
 * airborne — travel, tilt, hover jitter, the ground shadow, and going up in smoke
 * when the sweep finds nothing.
 *
 * The nesting is the animation, as in Dinosaur.tsx — one transform per layer,
 * because an element can only run one at a time:
 *
 *   .land-drone         travel between waypoints   (JS, from the route data)
 *   .land-drone-bank    tilt into the turn         (JS, same track)
 *   .land-drone-hover   rotor wash jitter          (CSS)
 *   .land-drone-rotor   blade spin                 (CSS, in DroneGlyph)
 *
 * Travel is driven by element.animate() rather than CSS because the route is
 * data: the waypoints come from `dronePatrol`, and a static `@keyframes` rule can
 * only reach them through custom properties, which pins the stop count for good
 * and puts the route somewhere no test can see it. The trade-off is that neither
 * the `.no-motion` class nor the reduced-motion media query can cancel a script
 * animation, so both are honoured here explicitly — and with the animation absent
 * the drone sits at its first waypoint, which is the whole reason the route is
 * expressed as offsets from a drawn origin.
 */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(REDUCED_MOTION).matches === true;
}

export default function Drone(props: {
  drone: DroneData;
  locked: boolean;
  motion?: boolean;
  /** Mid-explosion: the airframe is gone and only the burst is drawn. */
  bursting?: boolean;
  /**
   * What it is saying, already sized and shaped. Passed in rather than derived
   * here because the same object sets the flight bounds — computing it twice is
   * how a bubble ends up drawn somewhere the drone was never allowed to fly.
   */
  chat?: ChatBubble | null;
}) {
  let rootRef!: SVGGElement;
  let bankRef!: SVGGElement;

  // The OS setting can change while the app is open, and this is the only motion
  // on the map that CSS cannot switch off for us.
  const [reduced, setReduced] = createSignal(prefersReducedMotion());
  onMount(() => {
    const query = window.matchMedia?.(REDUCED_MOTION);
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    onCleanup(() => query.removeEventListener('change', onChange));
  });

  let running: Animation[] = [];

  /**
   * Stops the travel animations, optionally leaving the drone where they had it.
   *
   * `commitStyles` is what makes the explosion happen *there* rather than back at
   * the route's origin: it writes the animation's current transform to the
   * element before the animation — and with it the transform — disappears.
   */
  function stop(freeze = false): void {
    for (const animation of running) {
      if (freeze) {
        try {
          animation.commitStyles();
        } catch {
          // Only cosmetic: the burst then plays at the drawn origin instead.
        }
      }
      animation.cancel();
    }
    running = [];
  }

  createEffect(() => {
    const drone = props.drone;
    const bursting = props.bursting === true;
    const flying = props.motion !== false && !reduced();

    // A re-planned route restarts the lap, which is correct: a drone told about a
    // new device should head for it rather than finish the circuit it was on.
    stop(bursting);
    if (bursting || !flying || typeof rootRef.animate !== 'function') return;

    const timing = { duration: drone.duration * 1000, iterations: Infinity } as const;
    running = [
      rootRef.animate(patrolFrames(drone) as unknown as Keyframe[], timing),
      bankRef.animate(bankFrames(drone) as unknown as Keyframe[], timing),
    ];
  });

  onCleanup(() => stop());

  /** Nothing is said mid-explosion. */
  const chatter = createMemo(() => (props.bursting ? null : (props.chat ?? null)));

  return (
    <g
      class="land-drone"
      classList={{ locked: props.locked, bursting: props.bursting }}
      ref={rootRef}
      // The two light colours live in the map palette like every other colour on
      // this screen, but the swap between them is a state change on `.locked`,
      // so they are handed to CSS rather than written into a fill.
      style={{
        '--drone-light-idle': LAND.droneLightIdle,
        '--drone-light-locked': LAND.droneLightLocked,
      }}
    >
      <title>
        {props.bursting
          ? 'Survey drone — lost'
          : props.locked
            ? 'Survey drone — devices found'
            : 'Survey drone — scanning'}
      </title>

      {/* Outside the tilt and the hover, so the shadow tracks the drone across the
          ground without rolling or bobbing with the airframe. Gone during the
          burst: there is no longer anything up there to cast it. */}
      <Show when={!props.bursting}>
        <ellipse
          cx={props.drone.origin.x}
          cy={props.drone.origin.y + props.drone.size * 2.3}
          rx={props.drone.size * (props.drone.variant.bodyW + 0.26)}
          ry={props.drone.size * 0.17}
          fill={LAND.shadow}
          opacity="0.2"
        />
      </Show>

      <g class="land-drone-bank" ref={bankRef}>
        <Show
          when={!props.bursting}
          fallback={
            /* The end. A flash, a shockwave ring and debris thrown outward — then
               the panel unmounts the whole group, so nothing is left behind. */
            <g class="land-drone-burst">
              <circle
                class="land-drone-flash"
                cx={props.drone.origin.x}
                cy={props.drone.origin.y}
                r={props.drone.size * 0.7}
                fill={LAND.droneBurstCore}
              />
              <circle
                class="land-drone-wave"
                cx={props.drone.origin.x}
                cy={props.drone.origin.y}
                r={props.drone.size * 1.5}
                fill="none"
                stroke={LAND.droneBurstEdge}
                stroke-width={props.drone.size * 0.09}
              />
              <For each={burstShards(props.drone)}>
                {(shard) => (
                  <circle
                    class="land-drone-shard"
                    cx={props.drone.origin.x}
                    cy={props.drone.origin.y}
                    r={shard.r}
                    fill={shard.hot ? LAND.droneBurstEdge : props.drone.variant.shellDark}
                    style={{
                      '--shard-x': `${shard.dx.toFixed(2)}px`,
                      '--shard-y': `${shard.dy.toFixed(2)}px`,
                      'animation-delay': `${shard.delay.toFixed(3)}s`,
                    }}
                  />
                )}
              </For>
            </g>
          }
        >
          <g class="land-drone-hover">
            <DroneGlyph drone={props.drone} />
          </g>
        </Show>
      </g>

      {/* Outside the bank layer, so the bubble travels with the drone but stays
          level — text that tilts into every turn is unreadable. Last inside the
          group so it draws over the airframe rather than under a rotor.

          Two nested groups, because the rise-in animation is a CSS `transform`
          and would otherwise override the positioning one: a CSS transform beats
          the SVG attribute, which would park the bubble at the viewBox origin
          for as long as the animation ran. */}
      <Show when={chatter()}>
        {(chat) => (
          <g transform={`translate(${props.drone.origin.x} ${props.drone.origin.y})`}>
            <g class="land-drone-chat" data-kind={chat().kind}>
              {/* Tail first, so the body is painted over the join and no seam
                  shows where the two meet. */}
              <Show when={chat().tail}>
                <path class="land-drone-chat-tail" d={chat().tail} />
              </Show>
              <path class="land-drone-chat-box" d={chat().path} />
              {/* Open, unfilled strokes — the burst's ticks and the sketch's
                  second pass. Kept out of the body path so the fill rule
                  cannot decide what they look like. */}
              <For each={chat().accents}>
                {(accent) => <path class="land-drone-chat-accent" d={accent} />}
              </For>
              <text class="land-drone-chat-text" x={chat().textX} y={chat().textY}>
                {chat().text}
              </text>
            </g>
          </g>
        )}
      </Show>
    </g>
  );
}
