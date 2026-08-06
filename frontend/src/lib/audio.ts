// Dinosaur roars.
//
// No audio ships with the app: the pool is whatever the user added in Settings.
// Clips live outside the bundle, so the webview cannot fetch them directly —
// `go.GetAudioClip` reads the file and returns a data URL, which is cached here
// for the session so a repeat click never re-reads the disk.
//
// The split matters for tests: everything above the divider is pure and runs in
// the node vitest environment; only `playClip` touches Audio and the bridge.
// `wails` is imported dynamically for the same reason — it reads `window` at
// module scope, which would throw the moment a test imported this file.

import { hashText, makeRng } from './landscape/rng';

/**
 * Per-session salt for clip assignment.
 *
 * `clipForName` has to be stable while the app is open — clicking Rexy twice must
 * replay Rexy's clip, not roll a new one — but should differ between sessions so
 * the herd doesn't sound identical forever. One salt drawn at module load gives
 * both properties without storing an assignment anywhere. This is user-facing
 * randomness and never reaches the world generator, which stays seeded.
 */
export const SESSION_SALT = Math.floor(Math.random() * 0xffffffff) >>> 0;

/**
 * The clip a named dinosaur roars with, or null when the pool is empty.
 *
 * Keyed off the name, the same identity `randomDino` uses — there is no dinosaur
 * id to key off, and the name is already the stable handle.
 */
export function clipForName(name: string, clips: readonly string[], salt: number): string | null {
  if (clips.length === 0) return null;
  const rng = makeRng((hashText(name) ^ Math.imul(salt, 0x9e3779b1)) >>> 0);
  return rng.pick(clips);
}

/** Final path segment, for showing a clip in Settings without the full path. */
export function clipLabel(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/**
 * The folder a clip lives in, for the second line of a Settings row.
 *
 * Two clips can share a basename, and the basename alone then reads as a
 * duplicate; the directory is what tells them apart. Empty for a bare filename,
 * so the caller can skip the line rather than render a stray separator.
 */
export function clipDir(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut <= 0 ? '' : path.slice(0, cut);
}

/**
 * Adds paths to a pool, dropping duplicates and preserving order. Mirrors
 * audio.NormalizePaths in Go, which is the enforcement point; this one exists so
 * picking the same file twice doesn't visibly double it in the list.
 */
export function addClips(existing: readonly string[], incoming: readonly string[]): string[] {
  const out = [...existing];
  const seen = new Set(existing);
  for (const path of incoming) {
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

// --- playback (impure) ---

/** path → data URL, resolved once per session. */
const urlCache = new Map<string, string>();
/** path → element, so a second click restarts the clip rather than layering it. */
const players = new Map<string, HTMLAudioElement>();
/** Paths that failed to load — retrying every click would hammer a missing file. */
const failed = new Set<string>();

async function clipUrl(path: string): Promise<string | null> {
  const cached = urlCache.get(path);
  if (cached) return cached;
  if (failed.has(path)) return null;

  let url: string;
  try {
    const { go } = await import('../wails');
    url = await go.GetAudioClip(path);
  } catch (e) {
    console.warn('[audio] could not load clip', path, e);
    failed.add(path);
    return null;
  }
  // Go signals failure with the same "error: …" string the save methods use.
  if (!url || url.startsWith('error: ')) {
    console.warn('[audio]', url || 'empty response', path);
    failed.add(path);
    return null;
  }

  urlCache.set(path, url);
  return url;
}

/**
 * Plays a clip once, from the start. Returns the element so a caller that wants
 * to follow the playback — the Settings preview shows which row is sounding —
 * can listen for `ended`; callers that just want a roar ignore it.
 *
 * Every failure is swallowed with a console warning and reported as `null`: a
 * clip the user has since moved or deleted, or a decode the webview refuses,
 * must not break the panel.
 */
export async function playClip(path: string): Promise<HTMLAudioElement | null> {
  const url = await clipUrl(path);
  if (!url) return null;

  let el = players.get(path);
  if (!el) {
    el = new Audio(url);
    el.preload = 'auto';
    players.set(path, el);
  }

  try {
    el.currentTime = 0;
    await el.play();
  } catch (e) {
    console.warn('[audio] playback failed', path, e);
    return null;
  }
  return el;
}

/**
 * Forgets cached URLs and players. Called when the clip list changes so a path
 * the user removed and re-added is re-read, and so removed clips stop holding
 * their base64 payload in memory.
 *
 * Deliberately does not touch the fan loop. The loop is owned by whoever started
 * it — stopping it from here would silence the drone until some unrelated signal
 * happened to restart it, since the clip list changing is not a reason for the
 * drone to stop flying.
 */
export function resetAudioCache(): void {
  urlCache.clear();
  players.clear();
  failed.clear();
}

// --- looping playback (impure) ---

/**
 * The rotor hum is background, not an event: it plays under whatever else is
 * happening, so it sits well below the roars, which are deliberate one-offs.
 */
export const FAN_VOLUME = 0.32;

/**
 * Why a loop might not be sounding.
 *
 * 'blocked' is the interesting one and the common one: the webview refuses to
 * start audio that no user gesture asked for. A one-off roar is safe because it
 * *is* a click, but this loop starts because a drone took off, and by the time the
 * clip has been read off disk the gesture that opened the view is long expired. So
 * a blocked loop is not a failure — it is armed, and the user's next click
 * anywhere starts it.
 */
export type LoopStatus = 'stopped' | 'playing' | 'blocked' | 'failed';

let loopEl: HTMLAudioElement | null = null;
let loopPath: string | null = null;
let loopStatus: LoopStatus = 'stopped';
let loopVolume = FAN_VOLUME;
/**
 * Monotonic, because loading a clip is async: two starts in quick succession
 * would otherwise both reach `play()` and layer two hums over each other. The
 * newest ticket wins and the older load discards itself.
 */
let loopTicket = 0;
/** Removes the armed gesture listeners, if any are waiting. */
let disarm: (() => void) | null = null;
let statusListener: ((status: LoopStatus) => void) | null = null;

/** Which clip is currently looping, if any. */
export function loopingClip(): string | null {
  return loopPath;
}

export function clipLoopStatus(): LoopStatus {
  return loopStatus;
}

/**
 * Watches the loop's status, so a UI can explain a hum that isn't sounding.
 * One listener at a time — there is one loop.
 */
export function onClipLoopStatus(cb: (status: LoopStatus) => void): () => void {
  statusListener = cb;
  cb(loopStatus);
  return () => {
    if (statusListener === cb) statusListener = null;
  };
}

function setStatus(next: LoopStatus): void {
  if (loopStatus === next) return;
  loopStatus = next;
  statusListener?.(next);
}

/**
 * Waits for any click or keypress and then starts the loop from inside that
 * handler — synchronously, which is the whole point: the element is already
 * loaded, so nothing awaits between the gesture and `play()`.
 */
function armGesture(el: HTMLAudioElement): void {
  disarm?.();
  const onGesture = () => {
    // A stop, or a different clip, landed while we were waiting.
    if (loopEl !== el) {
      disarm?.();
      return;
    }
    void el
      .play()
      .then(() => {
        disarm?.();
        setStatus('playing');
      })
      .catch(() => {
        /* Still refused — stay armed for the next gesture. */
      });
  };

  window.addEventListener('pointerdown', onGesture);
  window.addEventListener('keydown', onGesture);
  disarm = () => {
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('keydown', onGesture);
    disarm = null;
  };
}

/**
 * Starts a clip looping, or leaves it alone if that clip is already looping.
 *
 * Idempotent on purpose: the caller is a reactive effect that re-runs whenever
 * anything about the drone changes, and a hum that restarted from the top on
 * every re-plan would stutter every time a device appeared.
 */
export async function startClipLoop(path: string, volume = FAN_VOLUME): Promise<LoopStatus> {
  loopVolume = volume;
  if (loopPath === path && loopEl) {
    loopEl.volume = volume;
    return loopStatus;
  }

  const ticket = ++loopTicket;
  stopClipLoop();
  loopTicket = ticket; // stopClipLoop bumped it; this start is still the newest.

  const url = await clipUrl(path);
  if (!url) {
    setStatus('failed');
    return 'failed';
  }
  if (ticket !== loopTicket) return loopStatus;

  const el = new Audio(url);
  el.loop = true;
  el.volume = loopVolume;
  el.preload = 'auto';

  // Registered before play() resolves, so a stop arriving mid-attempt still finds
  // the element to pause.
  loopEl = el;
  loopPath = path;

  try {
    await el.play();
  } catch (e) {
    if (ticket !== loopTicket) return loopStatus;
    // Not an error worth shouting about: the usual cause is autoplay policy, and
    // the fix is the user's next click rather than anything the app can do.
    console.info('[audio] loop waiting for a user gesture', path, e);
    armGesture(el);
    setStatus('blocked');
    return 'blocked';
  }

  if (ticket !== loopTicket) {
    el.pause();
    return loopStatus;
  }
  setStatus('playing');
  return 'playing';
}

/** Stops the loop and drops the element. Safe to call when nothing is looping. */
export function stopClipLoop(): void {
  loopTicket++;
  disarm?.();
  if (loopEl) {
    loopEl.pause();
    loopEl.src = '';
  }
  loopEl = null;
  loopPath = null;
  setStatus('stopped');
}
