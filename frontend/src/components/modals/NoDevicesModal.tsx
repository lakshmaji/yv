import { createMemo, onCleanup, onMount, For, Show } from 'solid-js';
import {
  appSettings,
  droneVariant,
  launchDrone,
  setAppSettings,
  setNoDevicesOpen,
  setSettingsModalOpen,
} from '../../store';
import { DRONE_VARIANTS, dronePatrol, droneExtent, type DroneVariant } from '../../lib/drone';
import { go } from '../../wails';
import DroneGlyph from '../discovery/DroneGlyph';

/**
 * Shown when a sweep comes back empty and the drone has gone up in smoke.
 *
 * It is the honest version of the old caption on the map, which sat over the
 * terrain and was unreadable against it. It is also where the fleet lives: the
 * only thing to do about an empty island is send another drone, so the choice of
 * which one belongs here rather than buried in Settings.
 *
 * Dismissible — the map is worth looking at with nothing on it — and the panel
 * reopens it from the toolbar status chip.
 */

/** Size of the aircraft in a picker tile, in the tile's own viewBox units. */
const PREVIEW_SIZE = 26;

export default function NoDevicesModal() {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setNoDevicesOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  /**
   * A parked drone of each variant, for the tiles.
   *
   * Built through `dronePatrol` rather than by hand so a preview is the same data
   * the map draws — a tile that diverged from the real aircraft would be worse
   * than no tile. The bounds are a single point, which is exactly what a picker
   * wants: no route, no travel, just the airframe.
   */
  const previews = createMemo(() =>
    DRONE_VARIANTS.map((variant) => {
      const extent = droneExtent(variant);
      const half = Math.max(extent.left, extent.right) * PREVIEW_SIZE;
      const top = extent.top * PREVIEW_SIZE;
      return {
        variant,
        drone: dronePatrol({
          bounds: { x: half, y: top, width: 0, height: 0 },
          size: PREVIEW_SIZE,
          variant,
        }),
        // Tight to the aircraft, and deliberately excluding the ground shadow's
        // reach — a tile is a photo of the machine, not of it flying.
        viewBox: `0 0 ${half * 2} ${top * 2}`,
      };
    }),
  );

  async function choose(variant: DroneVariant): Promise<void> {
    if (variant.id === droneVariant().id) return;
    const next = { ...appSettings(), droneVariant: variant.id };
    setAppSettings(next);
    // Persisted immediately: picking an airframe is a decision, not a draft, and
    // there is no Save button on this dialog.
    try {
      await go.SaveSettings(next);
    } catch (e) {
      console.warn('[discovery] could not save drone variant', e);
    }
  }

  const fanClip = () => appSettings().droneFanClip?.trim();

  return (
    <div
      class="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) setNoDevicesOpen(false);
      }}
    >
      <div class="modal-box nodev-modal">
        <div class="modal-title">No devices nearby</div>

        <div class="nodev-lead">
          The drone swept the island and found nothing, then went down. Open yv on another laptop on
          this network and send a new one out — it will spot them and lead you there.
        </div>

        <div class="modal-field-label">Send which drone?</div>
        <div class="nodev-fleet">
          <For each={previews()}>
            {(entry) => (
              <button
                type="button"
                class="nodev-variant"
                classList={{ selected: entry.variant.id === droneVariant().id }}
                title={entry.variant.blurb}
                onClick={() => void choose(entry.variant)}
              >
                <svg
                  class="nodev-variant-art"
                  viewBox={entry.viewBox}
                  preserveAspectRatio="xMidYMid meet"
                  aria-hidden="true"
                >
                  <DroneGlyph drone={entry.drone} />
                </svg>
                <span class="nodev-variant-name">{entry.variant.label}</span>
                <span class="nodev-variant-detail">
                  {entry.variant.rotors} rotors · {entry.variant.blades}-blade
                </span>
              </button>
            )}
          </For>
        </div>

        {/* The fan hum is the one part of this the dialog cannot fix itself, so it
            points at where it can be fixed rather than staying silent about it. */}
        <Show when={!fanClip()}>
          <button
            type="button"
            class="nodev-sound-hint"
            onClick={() => {
              setNoDevicesOpen(false);
              setSettingsModalOpen(true);
            }}
          >
            ♪ No rotor sound yet — add a clip in Settings
          </button>
        </Show>

        <div class="modal-footer">
          <button class="btn-cancel" onClick={() => setNoDevicesOpen(false)}>
            Not now
          </button>
          <button class="btn-primary" onClick={launchDrone}>
            ↻ Send another drone
          </button>
        </div>
      </div>
    </div>
  );
}
