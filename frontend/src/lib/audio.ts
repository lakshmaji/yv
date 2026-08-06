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
 * Plays a clip once, from the start.
 *
 * Every failure is swallowed with a console warning: a clip the user has since
 * moved or deleted, or a decode the webview refuses, must not break the panel.
 */
export async function playClip(path: string): Promise<void> {
  const url = await clipUrl(path);
  if (!url) return;

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
  }
}

/**
 * Forgets cached URLs and players. Called when the clip list changes so a path
 * the user removed and re-added is re-read, and so removed clips stop holding
 * their base64 payload in memory.
 */
export function resetAudioCache(): void {
  urlCache.clear();
  players.clear();
  failed.clear();
}
