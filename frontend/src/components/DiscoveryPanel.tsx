import { createEffect, createMemo, createSignal, onCleanup, onMount, For, Show } from 'solid-js';
import {
  appSettings,
  discoverySeed,
  setDiscoverySeed,
  discoveryMotion,
  setDiscoveryMotion,
  droneCrashClip,
  droneFanClip,
  droneLaunch,
  droneState,
  droneVariant,
  launchDrone,
  noDevicesOpen,
  setDroneState,
  setNoDevicesOpen,
  setSettingsModalOpen,
  peers,
  setPeers,
  peerByName,
  setSharePeer,
  setShareError,
  sharePeer,
} from '../store';
import { generateWorld, openGround, worldBiomeKinds, WORLD_H, WORLD_W } from '../lib/landscape/world';
import { BIOME_RAMPS, type BiomeKind } from '../lib/landscape/palette';
import {
  clipForName,
  onClipLoopStatus,
  playClip,
  resetAudioCache,
  SESSION_SALT,
  startClipLoop,
  stopClipLoop,
  type LoopStatus,
} from '../lib/audio';
import { dinoInsets, randomDinos, type Dino } from '../lib/dino';
import { DRONE_SIZE, dronePatrol, droneInsets } from '../lib/drone';
import { hashText } from '../lib/landscape/rng';
import { insetRect, quantizeRect, visibleViewBox } from '../lib/viewbox';
import { go } from '../wails';
import LandscapeMap from './discovery/LandscapeMap';
import NoDevicesModal from './modals/NoDevicesModal';
import ShareModal from './modals/ShareModal';

const BIOME_LABELS: Record<BiomeKind, string> = {
  grass: 'Lowland',
  highland: 'Highland',
  redrock: 'Red canyon',
  snowfield: 'Snowfield',
};

/**
 * Sizes are deliberately modest: a tree is only ~15px tall and a summit 50–130,
 * so anything much past 70 stops reading as an animal in a landscape and starts
 * competing with the mountains.
 */
const DINO_MIN_SIZE = 44;
const DINO_MAX_SIZE = 72;

/** Headroom for the hover name label, which is drawn above the animal. */
const DINO_LABEL_ROOM = 24;

export default function DiscoveryPanel() {
  // One memo is the whole regeneration mechanism: writing the seed rebuilds the
  // world, and Solid diffs the SVG for us.
  const world = createMemo(() => generateWorld(discoverySeed()));

  // The map is drawn with `slice`, so it is cropped to whatever shape the panel
  // is. Tracking the panel's size is the only way to know which viewBox
  // coordinates are actually on screen.
  let stageRef!: HTMLDivElement;
  const [stageSize, setStageSize] = createSignal({ width: 0, height: 0 });

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setStageSize({ width: box.width, height: box.height });
    });
    observer.observe(stageRef);
    onCleanup(() => observer.disconnect());
  });

  /**
   * Where a dinosaur may stand: the visible slice of the viewBox, pulled in by
   * the animal's own reach so none of them is clipped by the panel edge.
   *
   * Quantised because the bounds feed a seeded sample — without it every pixel
   * of a window drag would reroll the placement and the herd would flicker
   * across the island for the whole resize.
   */
  const dinoBounds = createMemo(() => {
    const visible = visibleViewBox({ width: WORLD_W, height: WORLD_H }, stageSize());
    const insets = dinoInsets(DINO_MAX_SIZE);
    return insetRect(quantizeRect(visible, 40), {
      ...insets,
      // The hover name sits above the animal, past its own reach, so the top
      // needs a little more room or the label clips for a dinosaur near the
      // upper edge — exactly when you are pointing at it.
      top: insets.top + DINO_LABEL_ROOM,
    });
  });

  /**
   * The herd is the network: one dinosaur per nearby yv instance, named for its
   * hostname. randomDino seeds from that name, so a given laptop is always the
   * same animal with the same voice — recognisable rather than decorative.
   *
   * The dinosaur utility knows nothing about islands or panels; it takes bounds
   * and a predicate, and finding somewhere to stand is the caller's business.
   */
  const dinos = createMemo(() =>
    randomDinos(
      peers().map((p) => p.name),
      {
        bounds: dinoBounds(),
        allow: openGround(world(), 30),
        // Hostnames are not unique — two "MacBook-Pro"s would otherwise draw as
        // one animal — so the peer id is mixed in. The world seed is folded in
        // too, so regenerating still reshuffles the herd.
        variantFor: (name) => {
          const peer = peerByName().get(name);
          return world().seed ^ hashText(peer?.id ?? name);
        },
        minSize: DINO_MIN_SIZE,
        maxSize: DINO_MAX_SIZE,
      },
    ),
  );

  /**
   * The scanning drone: one machine flying a circuit over the island.
   *
   * Its route is the search made visible — a sweep of open ground while nothing
   * has been found, and a tour of the herd once devices are there, dipping over
   * each animal as it passes. Deriving the targets from `dinos()` is what makes a
   * newly discovered device get visited: the route re-plans with the herd.
   *
   * Same quantised bounds as the herd, and for the same reason — an unquantised
   * rect would re-plan the circuit on every pixel of a window drag.
   */
  const droneBounds = createMemo(() => {
    const visible = visibleViewBox({ width: WORLD_W, height: WORLD_H }, stageSize());
    return insetRect(quantizeRect(visible, 40), droneInsets(DRONE_SIZE, droneVariant()));
  });

  const drone = createMemo(() =>
    dronePatrol({
      bounds: droneBounds(),
      // The launch counter is in the seed so a replacement drone flies a new
      // circuit rather than repeating the sweep that just came up empty.
      seed: world().seed ^ hashText(`launch:${droneLaunch()}`),
      // Over land: a survey drone circling the open sea is looking in the wrong
      // place. Once it is visiting animals the route follows them instead.
      allow: openGround(world(), 40),
      targets: dinos().map((d) => ({ x: d.x, y: d.y })),
      size: DRONE_SIZE,
      variant: droneVariant(),
    }),
  );

  // --- sound ---

  const clips = () => appSettings().audioClips ?? [];
  const soundOn = () => !appSettings().soundMuted;

  // A clip the user removed must stop holding its base64 payload, and one they
  // removed and re-added must be re-read rather than served from a stale entry.
  createEffect<string | undefined>((previous) => {
    const key = JSON.stringify(clips());
    if (previous !== undefined && key !== previous) resetAudioCache();
    return key;
  });

  // --- the sweep, and how it ends ---

  /**
   * How long a drone searches before giving up.
   *
   * Generous: mDNS answers in well under a second when anything is there, so this
   * is not a discovery timeout — it is how long the flight is worth watching
   * before the app admits there is nobody about.
   */
  const SWEEP_MS = 14_000;
  /** Length of the burst. Must match the CSS, which owns the animation. */
  const BURST_MS = 900;

  /**
   * When the current sweep runs out, and a clock to compare it against.
   *
   * The deadline is stored rather than a remaining count so the display cannot
   * drift from the timeout that actually fires — one setTimeout owns the ending,
   * and the ticker only decides how often the number is redrawn.
   */
  const [sweepEndsAt, setSweepEndsAt] = createSignal<number | null>(null);
  const [now, setNow] = createSignal(Date.now());

  /** The empty sweep: fly for a while, find nothing, come apart. */
  createEffect(() => {
    if (droneState() !== 'flying' || peers().length > 0) {
      setSweepEndsAt(null);
      return;
    }

    const timer = setTimeout(() => setDroneState('bursting'), SWEEP_MS);
    setSweepEndsAt(Date.now() + SWEEP_MS);
    // Four times a second: enough that the bar drains smoothly rather than
    // stepping once a second, which reads as a stall.
    const ticker = setInterval(() => setNow(Date.now()), 250);

    onCleanup(() => {
      clearTimeout(timer);
      clearInterval(ticker);
      setSweepEndsAt(null);
    });
  });

  /** Milliseconds left in the sweep, or null when nothing is counting down. */
  const sweepLeft = () => {
    const endsAt = sweepEndsAt();
    return endsAt === null ? null : Math.max(0, endsAt - now());
  };

  /** …then vanish and hand over to the dialog. */
  createEffect(() => {
    if (droneState() !== 'bursting') return;

    // The crash is its own clip, not the hum: it happens once, at a moment that
    // means something, and the hum has just stopped to make room for it.
    const crash = droneCrashClip();
    if (crash && soundOn()) void playClip(crash);

    const timer = setTimeout(() => {
      setDroneState('gone');
      // With discovery itself broken, the dialog's advice — open yv on another
      // laptop — is wrong, and sending another drone cannot help. The map says
      // what actually went wrong instead.
      if (!discoveryError()) setNoDevicesOpen(true);
    }, BURST_MS);
    onCleanup(() => clearTimeout(timer));
  });

  /**
   * A device turning up cancels all of that.
   *
   * Even mid-burst: the drone reappears rather than exploding pointlessly, which
   * is the right story — there is something out there to go and look at.
   */
  createEffect(() => {
    if (peers().length === 0) return;
    setNoDevicesOpen(false);
    if (droneState() !== 'flying') launchDrone();
  });

  /**
   * The rotor hum, while a drone is actually up.
   *
   * Tied to the panel, so leaving Discovery stops it. Tied to the motion toggle
   * too: with the map frozen, a hum over stationary rotors is incoherent.
   */
  const [fanStatus, setFanStatus] = createSignal<LoopStatus>('stopped');
  onMount(() => onCleanup(onClipLoopStatus(setFanStatus)));

  createEffect(() => {
    const clip = droneFanClip();
    const audible = droneState() === 'flying' && soundOn() && discoveryMotion() && clip !== null;
    if (audible && clip) void startClipLoop(clip);
    else stopClipLoop();
  });
  onCleanup(stopClipLoop);

  /**
   * Clicking a dinosaur roars and then opens the share flow.
   *
   * The roar comes first and is never awaited: the animal answers the pointer
   * immediately, and the modal does not wait on an audio file being read off
   * disk. Sound and sharing are independent — a muted herd still shares.
   */
  function handleSelect(dino: Dino): void {
    roar(dino);

    const peer = peerByName().get(dino.name);
    // A dinosaur with no peer behind it means the herd is mid-update; ignoring
    // the click is better than opening a modal that cannot send anything.
    if (peer) {
      setShareError(null);
      setSharePeer(peer);
    }
  }

  function roar(dino: Dino): void {
    if (!soundOn()) return;
    const clip = clipForName(dino.name, clips(), SESSION_SALT);
    if (!clip) return;
    void playClip(clip);
  }

  // --- discovery lifecycle ---

  // Set when the libp2p host cannot start at all — a different message from
  // "nobody is nearby", and the user cannot act on it the same way.
  const [discoveryError, setDiscoveryError] = createSignal<string | null>(null);

  onMount(() => {
    void (async () => {
      try {
        const res = await go.StartDiscovery();
        if (res.startsWith('error:')) {
          setDiscoveryError(res.slice(6).trim());
          return;
        }
      } catch (e) {
        setDiscoveryError(String(e));
        return;
      }

      // Re-sync from Go. App.tsx keeps the peer list current from the moment the
      // app starts, so this matters only when the frontend has been reloaded out
      // from under a still-running node — the dev hot reload — where the store is
      // fresh but the node already knows the herd.
      try {
        const known = await go.GetPeers();
        if (known?.length) setPeers(known);
      } catch { /* events will fill it in */ }
    })();
  });

  /**
   * What the toolbar says about the network.
   *
   * randomDinos silently drops an animal it cannot place — 24 rejection-sampling
   * attempts against a 150-unit gap inside the visible island — so on a small
   * window a discovered device can end up with no dinosaur. Saying so is the
   * difference between "nobody is there" and "you cannot reach them from here".
   */
  const peerStatus = () => {
    if (discoveryError()) return { label: '⚠ Discovery unavailable', warn: true };

    const found = peers().length;
    // Two ways of having nobody: still out looking, or the drone is down. The
    // second is a dead end the user can act on, so it says so and reopens the
    // dialog — the drone leaves no trace behind to click on.
    if (found === 0 && droneState() === 'gone') {
      return { label: '◌ No devices found', warn: true };
    }
    if (found === 0) return { label: '◌ Searching for nearby devices…', warn: false };

    const shown = dinos().length;
    if (shown < found) {
      return { label: `◉ ${found} nearby · ${found - shown} off-map`, warn: true };
    }
    return { label: `◉ ${found} device${found === 1 ? '' : 's'} nearby`, warn: false };
  };

  /**
   * Why the herd is silent, when it is — otherwise a click reads as broken.
   *
   * The blocked case earns its own line because it is the one that looks like a
   * bug: the user picked a clip, everything is configured, and nothing plays. The
   * webview will not start a loop that no gesture asked for, and the fix is a
   * click — so the chip asks for one instead of leaving them to guess.
   */
  const soundStatus = () => {
    if (!soundOn()) return { label: '♪ Sounds muted', action: true };
    if (fanStatus() === 'blocked') return { label: '♪ Click to start rotor sound', action: false };
    if (fanStatus() === 'failed') return { label: '♪ Rotor clip unplayable', action: true };
    // The other way the rotor clip can be silent with everything configured: no
    // drone is up to hum. Worth saying, or a working clip reads as a broken one.
    if (droneFanClip() && droneState() !== 'flying') {
      return { label: '♪ Silent — no drone in the air', action: false };
    }
    if (clips().length === 0) return { label: '♪ No sound clips yet', action: true };
    const n = clips().length;
    return { label: `♪ ${n} clip${n === 1 ? '' : 's'}`, action: false };
  };

  function reroll(): void {
    // Picking a seed is a user action, not generation — Math.random is fine
    // here, and never reaches the generator itself.
    setDiscoverySeed(Math.floor(Math.random() * 1_000_000_000));
  }

  return (
    <main id="main" class="discovery">
      <div id="dashboard-header">
        <div class="dash-heading">
          <span class="dash-title">Discovery</span>
          <span class="dash-subtitle">
            Nearby devices running yv appear as dinosaurs. Click one to share your commands with it.
          </span>
        </div>
      </div>

      <div class="dash-toolbar">
        {/* Leftmost because it is the only thing on this screen that reports
            something outside the app. */}
        <Show
          when={peers().length === 0 && droneState() === 'gone' && !discoveryError()}
          fallback={
            <span
              class="dash-refresh disc-peer-status"
              classList={{
                muted: peerStatus().warn,
                searching: peers().length === 0 && !discoveryError(),
              }}
              title={
                discoveryError()
                  ? `Discovery could not start: ${discoveryError()}`
                  : 'Devices on your network running yv, discovered over mDNS'
              }
            >
              {peerStatus().label}

              {/* How long this drone has left. Shown because the burst is
                  otherwise a surprise: it happens on a schedule the user cannot
                  see, and a countdown turns "it blew up" into "it ran out". */}
              <Show when={sweepLeft() !== null && !discoveryError()}>
                <span class="disc-sweep" title="The drone comes down when this runs out">
                  <span class="disc-sweep-left">{Math.ceil((sweepLeft() ?? 0) / 1000)}s</span>
                  <span
                    class="disc-sweep-bar"
                    style={{ '--sweep': ((sweepLeft() ?? 0) / SWEEP_MS).toFixed(3) }}
                  />
                </span>
              </Show>
            </span>
          }
        >
          <button
            type="button"
            class="dash-refresh disc-peer-status muted"
            title="The sweep found nothing — send another drone"
            onClick={() => setNoDevicesOpen(true)}
          >
            {peerStatus().label}
          </button>
        </Show>

        <button type="button" class="dash-refresh" onClick={reroll}>
          ↻ Regenerate
        </button>

        <button
          type="button"
          class="dash-refresh"
          classList={{ active: discoveryMotion() }}
          title="Water shimmer, drifting fog, canopy sway, dinosaur idles and the survey drone"
          onClick={() => setDiscoveryMotion(!discoveryMotion())}
        >
          {discoveryMotion() ? '◉ Motion on' : '○ Motion off'}
        </button>

        {/* A button rather than a label when there is something to fix: the
            answer to "why is it silent?" is always in Settings. */}
        <button
          type="button"
          class="dash-refresh disc-sound-status"
          classList={{ muted: soundStatus().action }}
          title={
            fanStatus() === 'blocked'
              ? 'The webview will not start looping audio until you interact with the window — click anywhere'
              : soundStatus().action
                ? 'Open Settings to add your own sound clips'
                : 'Click a dinosaur to hear it'
          }
          onClick={() => setSettingsModalOpen(true)}
        >
          {soundStatus().label}
        </button>

        <div class="disc-legend">
          <For each={worldBiomeKinds(world())}>
            {(kind) => (
              <span class="disc-legend-item">
                <span class="disc-swatch" style={{ background: BIOME_RAMPS[kind][2] }} />
                {BIOME_LABELS[kind]}
              </span>
            )}
          </For>
        </div>
      </div>

      <div
        class="landscape-stage"
        classList={{ 'no-motion': !discoveryMotion() }}
        ref={stageRef}
      >
        <LandscapeMap
          world={world()}
          dinos={dinos()}
          onSelectDino={handleSelect}
          drone={droneState() === 'gone' ? undefined : drone()}
          droneLocked={peers().length > 0}
          droneBursting={droneState() === 'bursting'}
          motion={discoveryMotion()}
        />

        {/* Discovery failing to start is not the same as nobody being there: no
            drone will help, so it stays on the map rather than becoming a dialog
            offering to send one. */}
        <Show when={discoveryError()}>
          <div class="landscape-empty">
            <span class="landscape-empty-title">Discovery unavailable</span>
            <span class="landscape-empty-hint">Discovery could not start on this machine.</span>
          </div>
        </Show>

        <div class="landscape-meta">
          {/* The seed is shown but not editable — it is here so a world you like
              can be noted down and asked for again, not as a control. */}
          <span>seed {world().seed}</span>
          <span>{world().trees.length} trees</span>
          <span>{world().peaks.length} peaks</span>
          <span>{world().settlements.length} settlements</span>
          <span>{world().rivers.length} waterways</span>
          <span>{dinos().length} nearby</span>
        </div>
      </div>

      <Show when={sharePeer()}>
        <ShareModal />
      </Show>

      {/* Never both: a share dialog means a device was found, which closes this
          one anyway. Ordered so that if they ever did overlap, the share wins. */}
      <Show when={noDevicesOpen() && !sharePeer()}>
        <NoDevicesModal />
      </Show>
    </main>
  );
}
