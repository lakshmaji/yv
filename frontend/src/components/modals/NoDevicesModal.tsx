import { createMemo, onCleanup, onMount, For, Show } from 'solid-js';
import {
  appSettings,
  droneVariant,
  launchDrone,
  setAppSettings,
  setNoDevicesOpen,
  setSettingsModalOpen,
  setUnreachable,
  unreachable,
} from '../../store';
import { DRONE_VARIANTS, dronePatrol, droneExtent, type DroneVariant } from '../../lib/drone';
import { go } from '../../wails';
import type { ShareStatus } from '../../types';
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

/**
 * The command that fixes the common Windows case, for a user to copy.
 *
 * Named as a constant because it appears in the dialog, in RELEASING.md and in
 * the installer, and three hand-typed copies of a netsh invocation would drift.
 * `%LOCALAPPDATA%`-style expansion is not attempted: the portable build can live
 * anywhere, so the path is left as the one thing they have to fill in.
 */
const NETSH_HINT =
  'netsh advfirewall firewall add rule name="yv (TCP-In)" dir=in action=allow ' +
  'program="C:\\Program Files\\yv\\yv.exe" protocol=TCP profile=private,domain enable=yes';

export default function NoDevicesModal() {
  /**
   * Resync the unreachable list from Go when the dialog opens.
   *
   * A replace, not a merge: the peer:unreachable event only ever adds, and a
   * device that has since left the network is swept in Go without any event —
   * peer:lost fires only for peers that made it onto the map. So the store can
   * hold a stale entry between openings, and Go's table is the authority. Same
   * division as peers()/GetPeers.
   */
  onMount(() => {
    void (async () => {
      try {
        const st: ShareStatus = await go.GetShareStatus();
        setUnreachable(st.unreachable ?? []);
      } catch (e) {
        // A dialog that cannot explain itself still has a fleet picker and a
        // retry button, which is what it had before this existed.
        console.warn('[discovery] could not read share status', e);
      }
    })();
  });

  /**
   * Devices mDNS reported that we never managed to connect to.
   *
   * This is the whole reason the dialog reads status at all. A dinosaur is drawn
   * only after a successful connection, so a peer whose host firewall refuses
   * unsolicited inbound is discovered and then silently dropped — and libp2p
   * links are bidirectional, so a pair where *both* ends filter inbound can
   * never connect in either direction, however healthy each looks against a
   * third machine that does not filter.
   *
   * A handshake still in flight is excluded: it has not failed yet, and counting
   * it would make the dialog accuse a network that is merely mid-connect.
   */
  const blocked = createMemo(() =>
    unreachable().filter((p) => p.reason !== 'still connecting'),
  );

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
        <div class="modal-title">
          {blocked().length > 0 ? 'Found, but not reachable' : 'No devices nearby'}
        </div>

        <Show
          when={blocked().length > 0}
          fallback={
            <div class="nodev-lead">
              The drone swept the island and found nothing, then went down. Open yv on another laptop
              on this network and send a new one out — it will spot them and lead you there.
            </div>
          }
        >
          <div class="nodev-lead">
            The drone spotted {blocked().length === 1 ? 'a device' : `${blocked().length} devices`}{' '}
            on this network but could not reach{' '}
            {blocked().length === 1 ? 'it' : 'them'} — so {blocked().length === 1 ? 'it' : 'they'}{' '}
            never landed on the map. Something is refusing the connection, almost always a firewall
            declining incoming connections on <em>one of the two</em> machines.
          </div>

          {/* Only one end has to accept: a connection carries traffic both ways
              once it exists. That is the single most useful thing to tell someone
              here, because it means they can fix either machine, not both. */}
          <div class="nodev-blocked-hint">
            Only one of the two needs to allow it. On Windows, the installer adds the rule for you —
            if yv was unzipped rather than installed, or the rule was refused, run this in an
            elevated PowerShell:
            <code class="nodev-cmd">{NETSH_HINT}</code>
            Check <code>Get-NetConnectionProfile</code> too: a network Windows has classified as{' '}
            <strong>Public</strong> ignores that rule. On macOS, allow yv incoming connections in
            System Settings → Network → Firewall.
          </div>

          <details class="nodev-detail">
            <summary>What the drone saw</summary>
            <For each={blocked()}>
              {(peer) => (
                <div class="nodev-detail-row">
                  <code>{peer.id.slice(-12)}</code>
                  <span>{peer.reason}</span>
                </div>
              )}
            </For>
          </details>
        </Show>

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
