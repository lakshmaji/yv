import { createEffect, createSignal, onCleanup, onMount, For } from 'solid-js';
import { bankFrames, droneShape, patrolFrames, type Drone as DroneData } from '../../lib/drone';
import { LAND } from '../../lib/landscape/palette';

/**
 * The survey drone: a quadcopter flying a circuit over the island while the app
 * looks for nearby devices.
 *
 * A projection of `droneShape`, the way Dinosaur.tsx projects `dinoShape` — the
 * geometry is data so it can be tested; this file is colour, layering and motion.
 *
 * The nesting is the animation, as in Dinosaur.tsx — one transform per layer,
 * because an element can only run one at a time:
 *
 *   .land-drone         travel between waypoints   (JS, from the route data)
 *   .land-drone-bank    tilt into the turn         (JS, same track)
 *   .land-drone-hover   rotor wash jitter          (CSS)
 *   .land-drone-rotor   blade spin                 (CSS)
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

/**
 * Rotor periods in seconds, per mount.
 *
 * All four deliberately different: four discs turning in lockstep read as one
 * rigid ornament, whereas a spread of periods reads as four motors.
 */
const ROTOR_SPIN = [0.3, 0.34, 0.32, 0.37];

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(REDUCED_MOTION).matches === true;
}

export default function Drone(props: { drone: DroneData; locked: boolean; motion?: boolean }) {
  const shape = () => droneShape(props.drone);

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
  function stop(): void {
    running.forEach((animation) => animation.cancel());
    running = [];
  }

  createEffect(() => {
    const drone = props.drone;
    const flying = props.motion !== false && !reduced();

    // A re-planned route restarts the lap, which is correct: a drone told about a
    // new device should head for it rather than finish the circuit it was on.
    stop();
    if (!flying || typeof rootRef.animate !== 'function') return;

    const timing = { duration: drone.duration * 1000, iterations: Infinity } as const;
    running = [
      rootRef.animate(patrolFrames(drone) as unknown as Keyframe[], timing),
      bankRef.animate(bankFrames(drone) as unknown as Keyframe[], timing),
    ];
  });

  onCleanup(stop);

  return (
    <g
      class="land-drone"
      classList={{ locked: props.locked }}
      ref={rootRef}
      // The two light colours live in the map palette like every other colour on
      // this screen, but the swap between them is a state change on `.locked`,
      // so they are handed to CSS rather than written into a fill.
      style={{
        '--drone-light-idle': LAND.droneLightIdle,
        '--drone-light-locked': LAND.droneLightLocked,
      }}
    >
      <title>{props.locked ? 'Survey drone — devices found' : 'Survey drone — scanning'}</title>

      {/* Outside the tilt and the hover, so the shadow tracks the drone across the
          ground without rolling or bobbing with the airframe. */}
      <ellipse {...shape().shadow} fill={LAND.shadow} opacity="0.2" />

      <g class="land-drone-bank" ref={bankRef}>
        <g class="land-drone-hover">
          {/* Arms first, so the body sits over the four roots. */}
          <For each={shape().arms}>
            {(arm) => (
              <rect
                {...arm.rect}
                fill={LAND.droneShellDark}
                transform={`rotate(${arm.angle} ${shape().origin.x} ${shape().origin.y})`}
              />
            )}
          </For>

          <For each={shape().skids}>
            {(skid) => <rect {...skid} fill={LAND.droneShellDark} opacity="0.85" />}
          </For>

          <rect {...shape().body} fill={LAND.droneShell} />
          <ellipse {...shape().canopy} fill={LAND.shadow} opacity="0.55" />
          <circle {...shape().camera} fill={LAND.droneShellDark} />

          <For each={shape().rotors}>
            {(rotor, i) => (
              <>
                <circle {...rotor.pod} fill={LAND.droneShellDark} />

                <g
                  class="land-drone-rotor"
                  style={{ 'animation-duration': `${ROTOR_SPIN[i() % ROTOR_SPIN.length]}s` }}
                >
                  {/* The disc is the blur a spinning rotor actually reads as; the
                      two blades on top are what make it read as spinning rather
                      than as a painted ring. */}
                  <circle {...rotor.disc} fill={LAND.droneBlade} opacity="0.14" />
                  <circle
                    {...rotor.disc}
                    fill="none"
                    stroke={LAND.droneBlade}
                    stroke-width={props.drone.size * 0.02}
                    opacity="0.3"
                  />
                  <ellipse {...rotor.blade} fill={LAND.droneBlade} opacity="0.8" />
                  <ellipse
                    {...rotor.blade}
                    fill={LAND.droneBlade}
                    opacity="0.8"
                    transform={`rotate(90 ${rotor.blade.cx} ${rotor.blade.cy})`}
                  />
                  <circle {...rotor.cap} fill={LAND.droneShell} />
                </g>

                {/* Status lights, one per pod. Amber while searching, green once
                    devices are found — the colour swap is CSS on `.locked`, so it
                    never interrupts the patrol. */}
                <circle class="land-drone-light-glow" {...rotor.glow} />
                <circle class="land-drone-light" {...rotor.light} />
              </>
            )}
          </For>
        </g>
      </g>
    </g>
  );
}
