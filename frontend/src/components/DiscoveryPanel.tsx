import { createEffect, createMemo, createSignal, onCleanup, onMount, For, Show } from 'solid-js';
import {
  appSettings,
  discoverySeed,
  setDiscoverySeed,
  discoveryMotion,
  waterMotion,
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
  openShareWith,
  shareStage,
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
import { DRONE_SIZE, droneInsets, droneMessage, dronePatrol } from '../lib/drone';
import { chatBubble } from '../lib/chatBubble';
import { hashText } from '../lib/landscape/rng';
import { insetRect, quantizeRect, visibleViewBox } from '../lib/viewbox';
import { go } from '../wails';
import LandscapeMap from './discovery/LandscapeMap';
import NoDevicesModal from './modals/NoDevicesModal';
import ShareModal from './modals/ShareModal';
import PeerConnectModal from './modals/PeerConnectModal';

const BIOME_LABELS: Record<BiomeKind, string> = {
  grass: 'Lowland',
  highland: 'Highland',
  redrock: 'Red canyon',
  snowfield: 'Snowfield',
};

/**
 * Animals already greeted with a roar.
 *
 * Module scope, not component scope, so leaving Discovery and coming back does
 * not re-announce a herd that never went anywhere — the peer list outlives the
 * panel, so the greeting has to as well.
 */
const greeted = new Set<string>();

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
   * The bubble the drone is currently showing, or null when it has nothing to
   * say.
   *
   * Built here, once, and passed down: the same object both constrains where the
   * drone may fly and gets drawn, so the box on screen can never be one the
   * flight bounds did not account for.
   */
  const droneChat = createMemo(() => {
    const text = droneMessage(dinos().length);
    if (text === null) return null;
    // Seeded from the launch and the world, so the shape holds still for the
    // whole sweep — a bubble that reshaped itself on every re-render would be
    // unreadable — and a later drone gets a different one.
    return chatBubble(text, DRONE_SIZE, world().seed ^ hashText(`chat:${droneLaunch()}`));
  });

  const droneBounds = createMemo(() => {
    const visible = quantizeRect(
      visibleViewBox({ width: WORLD_W, height: WORLD_H }, stageSize()),
      40,
    );
    const airframe = insetRect(visible, droneInsets(DRONE_SIZE, droneVariant()));
    const withChat = insetRect(visible, droneInsets(DRONE_SIZE, droneVariant(), droneChat()));

    // On a narrow panel the bubble's own width can leave almost nothing to fly
    // over. A drone pinned to one corner is a worse outcome than a bubble that
    // clips at the edge, so past a point the airframe's bounds win.
    return withChat.width > airframe.width * 0.45 ? withChat : airframe;
  });

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
    if (peer) openShareWith(peer);
  }

  function roar(dino: Dino): void {
    if (!soundOn()) return;
    const clip = clipForName(dino.name, clips(), SESSION_SALT);
    if (!clip) return;
    void playClip(clip);
  }

  /**
   * An arriving animal announces itself.
   *
   * Keyed by name rather than peer id because the name is what picks the clip,
   * so what you hear on arrival is the same voice you get by clicking it later.
   *
   * Departures are dropped from the set, which is what makes a device that goes
   * away and comes back an arrival again — and is also how a rescan re-arms the
   * greeting, since it empties the herd on its way out.
   */
  createEffect(() => {
    const herd = dinos();
    const present = new Set(herd.map((d) => d.name));
    for (const name of [...greeted]) {
      if (!present.has(name)) greeted.delete(name);
    }

    const arrived = herd.filter((d) => !greeted.has(d.name));
    // Marked greeted whether or not it is audible, so unmuting later does not
    // set off the whole herd at once for animals that arrived while muted.
    for (const d of arrived) greeted.add(d.name);
    for (const d of arrived) roar(d);
  });

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

  /**
   * The dead end: the sweep ended and nothing was found.
   *
   * Distinct from a discovery failure, which no amount of rescanning fixes and
   * so must not offer the same way out.
   */
  const noDevices = () =>
    peers().length === 0 && droneState() === 'gone' && !discoveryError();

  /** True while a rescan's stop/start round trip is in flight. */
  const [rescanning, setRescanning] = createSignal(false);

  /**
   * Forget the herd and go looking again.
   *
   * This restarts the Go node rather than merely clearing the peer list, which
   * would look identical for a second and then never recover: Go announces a
   * peer once, and App.tsx dedupes `peer:found` by id, so a device already known
   * to the node would never be re-announced and its dinosaur would be gone for
   * good. Stop() forgets the peers and closes the libp2p host; Start() builds a
   * fresh one and browses mDNS again, so the herd is rebuilt from what is
   * actually out there now rather than from what we happened to have seen.
   *
   * The island is redrawn along the way. A rescan discards everything it knew
   * about the network, so a fresh island is the honest picture of that — and it
   * makes the reset unmistakable in the half-second before the first answer
   * arrives, which is otherwise indistinguishable from nothing having happened.
   */
  async function rescan(): Promise<void> {
    // The round trip is not instant, and a second press mid-flight would race a
    // Stop against the previous Start and could leave discovery down.
    if (rescanning()) return;
    setRescanning(true);

    // Clear first, so the herd visibly goes away and a drone is up covering the
    // wait — the countdown then measures the new sweep, not the old one.
    setPeers([]);
    setDiscoveryError(null);
    reroll();
    launchDrone();

    try {
      await go.StopDiscovery();
      const res = await go.StartDiscovery();
      if (res.startsWith('error:')) setDiscoveryError(res.slice(6).trim());
    } catch (e) {
      setDiscoveryError(String(e));
    } finally {
      setRescanning(false);
    }
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
            something outside the app.

            A button in every state, not just the no-devices one: with the
            separate map button gone, redrawing the island now rides along with
            the search-related controls, and this chip is one of them. In the
            no-devices state it additionally reopens the dialog, which is the
            only route back to the fleet picker once the drone has left no
            trace on the map to click. */}
        <button
          type="button"
          class="dash-refresh disc-peer-status"
          classList={{
            muted: peerStatus().warn,
            searching: peers().length === 0 && !discoveryError(),
          }}
          title={
            discoveryError()
              ? `Discovery could not start: ${discoveryError()}`
              : noDevices()
                ? 'The sweep found nothing — send another drone, on a fresh island'
                : 'Devices on your network running yv, discovered over mDNS. Click to redraw the island.'
          }
          onClick={() => {
            reroll();
            if (noDevices()) setNoDevicesOpen(true);
          }}
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
        </button>

        <button
          type="button"
          class="dash-refresh"
          // Deliberately still enabled when discovery failed to start: a rescan
          // is a full stop/start, so it is the retry for exactly that case.
          disabled={rescanning()}
          title="Forget the devices found so far and search the network again, on a fresh island"
          onClick={() => void rescan()}
        >
          {rescanning() ? '↻ Rescanning…' : '↻ Rescan'}
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
        classList={{
          'no-motion': !discoveryMotion(),
          // Independent of Motion: the settings preference has to hold the water
          // still even with the rest of the map animating.
          'no-water-motion': !waterMotion(),
        }}
        ref={stageRef}
      >
        <LandscapeMap
          world={world()}
          dinos={dinos()}
          onSelectDino={handleSelect}
          drone={droneState() === 'gone' ? undefined : drone()}
          droneLocked={peers().length > 0}
          droneChat={droneChat()}
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

      {/* Connecting comes first and on its own: nothing is composed until the
          far end has let us in. */}
      <Show when={sharePeer() && shareStage() === 'connect'}>
        <PeerConnectModal />
      </Show>
      <Show when={sharePeer() && shareStage() === 'transfer'}>
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
