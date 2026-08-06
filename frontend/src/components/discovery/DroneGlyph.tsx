import { For } from 'solid-js';
import { droneShape, type Drone as DroneData } from '../../lib/drone';
import { LAND } from '../../lib/landscape/palette';

/**
 * The airframe itself: a projection of `droneShape`, with no travel and no state.
 *
 * Separate from Drone.tsx because the variant picker draws the same aircraft
 * standing still in a small box. Sharing the drawing is the point — a picker that
 * previewed something subtly different from what gets sent would be worse than no
 * preview at all.
 *
 * Rotor spin lives here (it is part of the aircraft), hover jitter and travel do
 * not (they are part of flying).
 */

/**
 * Rotor periods in seconds, by mount.
 *
 * All different: rotors turning in lockstep read as one rigid ornament, whereas a
 * spread of periods reads as independent motors. Six entries so a hexa gets a
 * distinct value per rotor too.
 */
const ROTOR_SPIN = [0.3, 0.34, 0.32, 0.37, 0.31, 0.35];

export default function DroneGlyph(props: { drone: DroneData }) {
  const shape = () => droneShape(props.drone);
  const v = () => props.drone.variant;

  return (
    <>
      {/* Arms first, so the body sits over the four roots. */}
      <For each={shape().arms}>
        {(arm) => (
          <rect
            {...arm.rect}
            fill={v().shellDark}
            transform={`rotate(${arm.angle} ${shape().origin.x} ${shape().origin.y})`}
          />
        )}
      </For>

      <For each={shape().skids}>
        {(skid) => <rect {...skid} fill={v().shellDark} opacity="0.85" />}
      </For>

      <rect {...shape().body} fill={v().shell} />
      <ellipse {...shape().canopy} fill={LAND.shadow} opacity="0.55" />
      <circle {...shape().camera} fill={v().shellDark} />

      <For each={shape().rotors}>
        {(rotor, i) => (
          <>
            <circle {...rotor.pod} fill={v().shellDark} />

            <g
              class="land-drone-rotor"
              style={{ 'animation-duration': `${ROTOR_SPIN[i() % ROTOR_SPIN.length]}s` }}
            >
              {/* The disc is the blur a spinning rotor actually reads as; the
                  blades on top are what make it read as spinning rather than as
                  a painted ring. */}
              <circle {...rotor.disc} fill={v().blade} opacity="0.14" />
              <circle
                {...rotor.disc}
                fill="none"
                stroke={v().blade}
                stroke-width={props.drone.size * 0.02}
                opacity="0.3"
              />
              <For each={shape().blades}>
                {(angle) => (
                  <ellipse
                    {...rotor.blade}
                    fill={v().blade}
                    opacity="0.8"
                    transform={`rotate(${angle} ${rotor.blade.cx} ${rotor.blade.cy})`}
                  />
                )}
              </For>
              <circle {...rotor.cap} fill={v().shell} />
            </g>

            {/* Status lights, one per rotor. Amber while searching, green once
                devices are found — the colour swap is CSS on `.locked`, so it
                never interrupts the patrol. */}
            <circle class="land-drone-light-glow" {...rotor.glow} />
            <circle class="land-drone-light" {...rotor.light} />
          </>
        )}
      </For>
    </>
  );
}
