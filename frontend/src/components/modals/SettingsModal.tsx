import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { appSettings, setAppSettings, settingsModalOpen, setSettingsModalOpen } from '../../store';
import { go } from '../../wails';
import { PANELS, togglePanel } from '../../lib/dashboardPanels';
import { addClips, clipDir, clipLabel, playClip } from '../../lib/audio';
import { DRONE_VARIANTS, variantById } from '../../lib/drone';
import { formatBytes, shortenPath } from '../../lib/utils';
import type { AppSettings, MetricsStorageInfo, PanelId } from '../../types';

// The useful range spans three orders of magnitude and every value in it is
// arbitrary, so a fixed list beats a number input nobody knows how to fill in.
// Kept at or above settings.MinScanInterval in Go, which is the enforcement point.
const SCAN_INTERVALS = [
  { minutes: 0, label: 'Never' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 240, label: 'Every 4 hours' },
  { minutes: 720, label: 'Every 12 hours' },
  { minutes: 1440, label: 'Once a day' },
];

// Mirrors internal/settings.MinRetentionDays / MaxRetentionDays, which is the
// enforcement point.
const MIN_RETENTION = 1;
const MAX_RETENTION = 3650;

// Mirrors internal/settings.MaxUsernameLen. Counted in code points, as the Go
// side does — [...name].length, not name.length, or a name of emoji is cut at a
// fraction of the characters the user can see.
const MAX_USERNAME = 32;

export default function SettingsModal() {
  const [enabled, setEnabled] = createSignal(false);
  const [retention, setRetention] = createSignal('365');
  const [panels, setPanels] = createSignal<PanelId[]>([]);
  const [username, setUsername] = createSignal('');
  // The hostname the device falls back to. Shown as the placeholder so the
  // default is visible rather than something the user has to ask a colleague.
  const [defaultName, setDefaultName] = createSignal('');
  const [soundOn, setSoundOn] = createSignal(true);
  const [waterOn, setWaterOn] = createSignal(true);
  const [clips, setClips] = createSignal<string[]>([]);
  // The Discovery drone: which airframe goes out, and the clip its rotors hum.
  const [variantId, setVariantId] = createSignal('');
  const [fanClip, setFanClip] = createSignal('');
  const [crashClip, setCrashClip] = createSignal('');
  // Where to look for committed yv.yaml files, and how often.
  const [scanDir, setScanDir] = createSignal('');
  const [scanInterval, setScanInterval] = createSignal(0);
  const [storage, setStorage] = createSignal<MetricsStorageInfo | null>(null);
  const [confirmClear, setConfirmClear] = createSignal(false);
  const [error, setError] = createSignal('');

  // Preview playback. `playing` drives the row's play/pause button; `broken`
  // remembers clips that would not load, so the row can say so instead of
  // looking identical to a working one that the user simply hasn't tried.
  // Share PIN. Empty means no PIN, which is the default.

  const [playing, setPlaying] = createSignal<string | null>(null);
  const [broken, setBroken] = createSignal<string[]>([]);
  let preview: HTMLAudioElement | null = null;
  let pausedPath = ''; // the clip `preview` is holding a position in, if paused
  let previewTicket = 0;

  // Snapshot on open so Cancel discards cleanly.
  createEffect(() => {
    if (!settingsModalOpen()) return;

    const current = appSettings();
    setEnabled(current.metricsEnabled);
    setRetention(String(current.retentionDays));
    setPanels([...(current.panels || [])]);
    setUsername(current.username || '');
    setSoundOn(!current.soundMuted);
    setWaterOn(!current.waterStill);
    setClips([...(current.audioClips || [])]);
    setVariantId(variantById(current.droneVariant).id);
    setFanClip(current.droneFanClip || '');
    setCrashClip(current.droneCrashClip || '');
    setScanDir(current.scanDir || '');
    setScanInterval(current.scanInterval || 0);
    setConfirmClear(false);
    setError('');
    setBroken([]);
    stopPreview();

    void refreshStorage();
    void refreshDefaultName();
  });

  // A clip left mid-roar would keep playing over the app once the modal is gone.
  onCleanup(stopPreview);

  async function pickScanDir() {
    const dir = await go.PickFolder();
    if (!dir) return; // cancelled
    setScanDir(dir);
    // Choosing a folder for the first time is as close to opting in as this
    // gets, so give it a schedule rather than leaving a folder that is never
    // actually looked at.
    if (scanInterval() === 0) setScanInterval(240);
  }

  async function refreshStorage() {
    try {
      setStorage(await go.GetMetricsStorageInfo());
    } catch {
      setStorage(null);
    }
  }

  /** The hostname is only ever a placeholder, so a failure just leaves it blank. */
  async function refreshDefaultName() {
    try {
      setDefaultName(await go.GetDefaultDeviceName());
    } catch {
      setDefaultName('');
    }
  }

  function close() {
    stopPreview();
    setSettingsModalOpen(false);
    setError('');
  }

  /** Pause where it is, so pressing play again resumes rather than restarts. */
  function pausePreview() {
    preview?.pause();
    previewTicket++; // abandons any clip still loading
    setPlaying(null);
  }

  /** Pause and forget the position — for switching clips, closing, removing. */
  function stopPreview() {
    pausePreview();
    preview = null;
    pausedPath = '';
  }

  /**
   * Play the clip, pause it if it is the one already sounding, or resume it if
   * it is the one paused.
   *
   * Only one preview runs at a time — starting a second while the first plays
   * would be two roars at once, which tells the user nothing about either.
   */
  async function togglePreview(path: string) {
    if (playing() === path) {
      pausedPath = path;
      pausePreview();
      return;
    }
    if (pausedPath === path && preview) {
      const resumed = preview;
      previewTicket++;
      setPlaying(path);
      void resumed.play().catch(() => stopPreview());
      return;
    }

    stopPreview();
    const ticket = ++previewTicket;

    const el = await playClip(path);
    if (!el) {
      if (ticket === previewTicket) setBroken([...new Set([...broken(), path])]);
      return;
    }
    // Loading a clip is async, so a later click can land first. Whoever asked
    // most recently wins; an older request stops rather than layering a second
    // roar over the new one.
    if (ticket !== previewTicket) {
      el.pause();
      return;
    }
    setBroken(broken().filter((p) => p !== path));
    preview = el;
    setPlaying(path);
    el.onended = () => {
      if (playing() === path) stopPreview();
    };
  }

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  /** Same rule the Go side enforces; runs here for immediate feedback. */
  function validate(): string {
    const days = Number(retention());
    if (!Number.isInteger(days) || days < MIN_RETENTION || days > MAX_RETENTION) {
      return `Retention must be a whole number between ${MIN_RETENTION} and ${MAX_RETENTION} days.`;
    }
    if ([...username().trim()].length > MAX_USERNAME) {
      return `Your name must be at most ${MAX_USERNAME} characters.`;
    }
    return '';
  }

  async function handleSave() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    const payload: AppSettings = {
      schemaVersion: appSettings().schemaVersion || 1,
      metricsEnabled: enabled(),
      retentionDays: Number(retention()),
      panels: panels(),
      username: username().trim(),
      soundMuted: !soundOn(),
      waterStill: !waterOn(),
      audioClips: clips(),
      droneVariant: variantId(),
      droneFanClip: fanClip().trim(),
      droneCrashClip: crashClip().trim(),
      scanDir: scanDir().trim(),
      scanInterval: scanInterval(),
    };

    // A rejected binding call would otherwise leave the modal open with no
    // explanation, which reads as "Save is broken".
    try {
      const result = await go.SaveSettings(payload);
      if (result !== 'ok') {
        setError(result);
        return;
      }
      setAppSettings(await go.GetSettings());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    close();
  }

  /** Multi-select, so a whole folder's worth of roars is one trip. */
  async function handleAddClips() {
    try {
      const picked = await go.PickAudioClips();
      if (picked.length === 0) return; // cancelled
      setClips(addClips(clips(), picked));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function removeClip(path: string) {
    if (playing() === path) stopPreview();
    setClips(clips().filter((p) => p !== path));
    setBroken(broken().filter((p) => p !== path));
  }

  function removeAllClips() {
    stopPreview();
    setClips([]);
    setBroken([]);
  }

  /**
   * Picks one clip, for a setting that holds a single file.
   *
   * The dialog is multi-select — it is the same one the roars use — so the first
   * file wins rather than the choice being rejected for having too many.
   */
  async function pickSingleClip(assign: (path: string) => void) {
    try {
      const picked = await go.PickAudioClips();
      if (picked.length === 0) return; // cancelled
      assign(picked[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * A settings row holding one clip: the pick/change control and, once there is a
   * file, a preview row identical to the ones in the roar pool.
   *
   * Local to this modal because it closes over the shared preview state — the
   * rotor hum and the crash share `playing`, so only one of them can sound at a
   * time, which is what you want when auditioning two clips against each other.
   */
  function SingleClipRow(props: {
    label: string;
    hint: string;
    path: string;
    onPick: () => void;
    onClear: () => void;
  }) {
    return (
      <>
        <div class="settings-row settings-clip-header">
          <div class="settings-row-main">
            <div class="settings-row-label">{props.label}</div>
            <div class="settings-row-hint">{props.hint}</div>
          </div>
          <span class="settings-row-control">
            <Show when={props.path}>
              <button type="button" class="settings-clip-clear" onClick={props.onClear}>
                Remove
              </button>
            </Show>
            <button type="button" onClick={props.onPick}>
              {props.path ? 'Change…' : '+ Choose clip…'}
            </button>
          </span>
        </div>

        <Show when={props.path}>
          {(path) => (
            <div class="settings-clip-list">
              <div
                class="settings-clip-row"
                classList={{ playing: playing() === path(), broken: broken().includes(path()) }}
              >
                {/* A hum or a crash is even harder to identify from a filename
                    than a roar is — worth hearing before it plays itself. */}
                <button
                  type="button"
                  class="settings-clip-play"
                  title={playing() === path() ? 'Pause' : 'Play this clip'}
                  aria-label={playing() === path() ? 'Pause' : 'Play this clip'}
                  onClick={() => void togglePreview(path())}
                >
                  {playing() === path() ? '❚❚' : '▶'}
                </button>
                <span class="settings-clip-main" title={path()}>
                  <span class="settings-clip-name">{clipLabel(path())}</span>
                  <Show when={clipDir(path())}>
                    {(dir) => <span class="settings-clip-path">{dir()}</span>}
                  </Show>
                </span>
                <Show when={broken().includes(path())}>
                  <span class="settings-clip-broken" title="This file could not be played">
                    unplayable
                  </span>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </>
    );
  }

  async function handleClear() {
    if (!confirmClear()) {
      setConfirmClear(true);
      return;
    }
    try {
      const result = await go.ClearMetrics();
      if (result !== 'ok') {
        setError(result);
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setConfirmClear(false);
    await refreshStorage();
  }

  const storageSummary = () => {
    const s = storage();
    if (!s || s.files === 0) return 'Nothing collected yet.';
    const since = s.oldestDay ? ` · since ${s.oldestDay}` : '';
    const files = s.files === 1 ? '1 file' : `${s.files} files`;
    return `${files} · ${formatBytes(s.bytes)}${since}`;
  };

  return (
    <Show when={settingsModalOpen()}>
      <div class="modal-overlay" onClick={handleOverlayClick}>
        <div class="modal-box settings-modal">
          <div class="modal-title">Settings</div>

          <div class="settings-section">
            <div class="settings-section-title">Usage metrics</div>

            <label class="settings-row settings-toggle">
              <div class="settings-row-main">
                <div class="settings-row-label">Collect usage metrics</div>
                <div class="settings-row-hint">
                  Records memory, CPU, and command runs so the dashboard can chart them. While this
                  is off, nothing is written to disk.
                </div>
              </div>
              <input
                type="checkbox"
                checked={enabled()}
                onChange={(e) => setEnabled(e.currentTarget.checked)}
              />
            </label>

            <label class="settings-row">
              <div class="settings-row-main">
                <div class="settings-row-label">Keep data for</div>
                <div class="settings-row-hint">
                  Days of history to retain. Older days are deleted automatically.
                </div>
              </div>
              <span class="settings-row-control">
                <input
                  type="number"
                  min={MIN_RETENTION}
                  max={MAX_RETENTION}
                  value={retention()}
                  disabled={!enabled()}
                  onInput={(e) => setRetention(e.currentTarget.value)}
                />
                <span class="settings-unit">days</span>
              </span>
            </label>

            <div class="settings-row">
              <div class="settings-row-main">
                <div class="settings-row-label">Stored data</div>
                <div class="settings-row-hint">{storageSummary()}</div>
              </div>
              <button
                type="button"
                class="btn-danger"
                onClick={handleClear}
                disabled={(storage()?.files ?? 0) === 0}
              >
                {confirmClear() ? 'Confirm delete' : 'Clear collected data'}
              </button>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-section-title">Dashboard panels</div>
            <div class="settings-section-hint">Choose which sections the dashboard shows.</div>

            <For each={PANELS}>
              {(panel) => (
                <label class="settings-row settings-toggle">
                  <div class="settings-row-main">
                    <div class="settings-row-label">{panel.label}</div>
                    <div class="settings-row-hint">{panel.description}</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={panels().includes(panel.id)}
                    onChange={() => setPanels(togglePanel(panels(), panel.id))}
                  />
                </label>
              )}
            </For>
          </div>

          <div class="settings-section">
            <div class="settings-section-title">Discovery map</div>

            <label class="settings-row settings-toggle">
              <div class="settings-row-main">
                <div class="settings-row-label">Animate sea and rivers</div>
                <div class="settings-row-hint">
                  Swell rolling in against the coast, and the current running down each
                  river. Turning this off leaves the rest of the map moving — use Motion
                  in the Discovery toolbar to stop everything.
                </div>
              </div>
              <input
                type="checkbox"
                checked={waterOn()}
                onChange={(e) => setWaterOn(e.currentTarget.checked)}
              />
            </label>
          </div>

          <div class="settings-section">
            <div class="settings-section-title">Dinosaur sounds</div>
            <div class="settings-section-hint">
              No audio ships with the app — add your own clips and each dinosaur in Discovery is
              given one at random for the session.
            </div>

            <label class="settings-row settings-toggle">
              <div class="settings-row-main">
                <div class="settings-row-label">Roar when a dinosaur is clicked</div>
                <div class="settings-row-hint">
                  Plays the clip once. Clicking the same dinosaur again replays the same clip.
                </div>
              </div>
              <input
                type="checkbox"
                checked={soundOn()}
                onChange={(e) => setSoundOn(e.currentTarget.checked)}
              />
            </label>

            <div class="settings-row settings-clip-header">
              <div class="settings-row-main">
                <div class="settings-row-label">Sound clips</div>
                <div class="settings-row-hint">
                  {clips().length === 0
                    ? 'None yet — the dinosaurs are silent until you add some.'
                    : `${clips().length} clip${clips().length === 1 ? '' : 's'} in the pool · ▶ to hear one.`}
                </div>
              </div>
              <span class="settings-row-control">
                <Show when={clips().length > 0}>
                  <button type="button" class="settings-clip-clear" onClick={removeAllClips}>
                    Remove all
                  </button>
                </Show>
                <button type="button" onClick={handleAddClips}>
                  + Add clips…
                </button>
              </span>
            </div>

            <Show
              when={clips().length > 0}
              fallback={
                <button type="button" class="settings-clip-empty" onClick={handleAddClips}>
                  <span class="settings-clip-empty-icon">🔈</span>
                  <span class="settings-clip-empty-text">
                    Add .mp3, .m4a, .aac, .wav, .ogg or .flac files to give the herd a voice
                  </span>
                </button>
              }
            >
              <div class="settings-clip-list">
                <For each={clips()}>
                  {(path) => (
                    <div
                      class="settings-clip-row"
                      classList={{
                        playing: playing() === path,
                        broken: broken().includes(path),
                      }}
                    >
                      {/* Preview is the only way to tell one roar from another —
                          the filename rarely says what the clip sounds like. */}
                      <button
                        type="button"
                        class="settings-clip-play"
                        title={playing() === path ? 'Pause' : 'Play this clip'}
                        aria-label={playing() === path ? 'Pause' : 'Play this clip'}
                        onClick={() => void togglePreview(path)}
                      >
                        {playing() === path ? '❚❚' : '▶'}
                      </button>
                      {/* The basename identifies a clip at a glance; the folder
                          below it disambiguates two files that share a name. */}
                      <span class="settings-clip-main" title={path}>
                        <span class="settings-clip-name">{clipLabel(path)}</span>
                        <Show when={clipDir(path)}>
                          {(dir) => <span class="settings-clip-path">{dir()}</span>}
                        </Show>
                      </span>
                      <Show when={broken().includes(path)}>
                        <span class="settings-clip-broken" title="This file could not be played">
                          unplayable
                        </span>
                      </Show>
                      <button
                        type="button"
                        class="settings-clip-remove"
                        title="Remove this clip"
                        aria-label="Remove this clip"
                        onClick={() => removeClip(path)}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <div class="settings-section">
            <div class="settings-section-title">Survey drone</div>
            <div class="settings-section-hint">
              A drone sweeps the Discovery map looking for nearby devices. If it finds nothing it
              comes down, and you can send another one out.
            </div>

            <div class="settings-row settings-clip-header">
              <div class="settings-row-main">
                <div class="settings-row-label">Airframe</div>
                <div class="settings-row-hint">
                  {variantById(variantId()).blurb} · also pickable when a sweep comes up empty.
                </div>
              </div>
              <span class="settings-row-control">
                <select value={variantId()} onChange={(e) => setVariantId(e.currentTarget.value)}>
                  <For each={DRONE_VARIANTS}>
                    {(v) => <option value={v.id}>{v.label}</option>}
                  </For>
                </select>
              </span>
            </div>

            <SingleClipRow
              label="Rotor sound"
              hint={
                fanClip()
                  ? 'Loops quietly while a drone is patrolling.'
                  : 'None yet — the drone flies silently until you add a clip.'
              }
              path={fanClip()}
              onPick={() => void pickSingleClip(setFanClip)}
              onClear={() => setFanClip('')}
            />

            <SingleClipRow
              label="Crash sound"
              hint={
                crashClip()
                  ? 'Plays once when a drone comes down after an empty sweep.'
                  : 'None yet — a drone comes down silently until you add a clip.'
              }
              path={crashClip()}
              onPick={() => void pickSingleClip(setCrashClip)}
              onClear={() => setCrashClip('')}
            />
          </div>

          <div class="settings-section">
            <div class="settings-section-title">Project scanning</div>
            <div class="settings-section-hint">
              Commit a <code>yv.yaml</code> to a repository and yv can find it. Pick the folder
              your code lives in and yv will offer to import any project configs it finds —
              you are always asked first, and importing never runs anything.
            </div>

            <div class="settings-row">
              <div class="settings-row-main">
                <div class="settings-row-label">Scan folder</div>
                <div class="settings-row-hint">
                  Sub-folders are searched too. Dependency and build directories —
                  <code>node_modules</code>, <code>build</code>, <code>Pods</code>, and anything
                  starting with a dot — are skipped.
                </div>
              </div>
              <span class="settings-row-control settings-scan-control">
                <span class="settings-scan-path" title={scanDir() || undefined}>
                  {scanDir() ? shortenPath(scanDir(), 3) : 'Not set'}
                </span>
                <button onClick={pickScanDir}>Browse…</button>
                <Show when={scanDir()}>
                  <button onClick={() => { setScanDir(''); setScanInterval(0); }}>Clear</button>
                </Show>
              </span>
            </div>

            <div class="settings-row">
              <div class="settings-row-main">
                <div class="settings-row-label">Scan automatically</div>
                <div class="settings-row-hint">
                  {scanDir()
                    ? 'You are asked before anything is imported, and only about files that are new or have changed.'
                    : 'Pick a scan folder first.'}
                </div>
              </div>
              <span class="settings-row-control">
                <select
                  disabled={!scanDir()}
                  value={String(scanInterval())}
                  onChange={(e) => setScanInterval(Number(e.currentTarget.value))}
                >
                  <For each={SCAN_INTERVALS}>
                    {(opt) => <option value={String(opt.minutes)}>{opt.label}</option>}
                  </For>
                </select>
              </span>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-section-title">Sharing</div>
            <div class="settings-section-hint">
              Nearby devices running yv appear as dinosaurs in Discovery, and can offer to share
              their commands with you. Environment variables are never shared.
            </div>

            <label class="settings-row">
              <div class="settings-row-main">
                <div class="settings-row-label">Your name</div>
                <div class="settings-row-hint">
                  {username().trim()
                    ? 'What nearby devices call you, and the dinosaur they see. Leave it empty to go back to this computer’s name.'
                    : `Optional. Nearby devices currently see ${
                        defaultName() || 'this computer’s name'
                      } — set a name if that isn’t how you want to be recognised.`}
                </div>
              </div>
              <span class="settings-row-control">
                <input
                  type="text"
                  class="settings-username-input"
                  placeholder={defaultName()}
                  // Deliberately no maxlength: it counts UTF-16 units, so it
                  // would stop a name of emoji at half the characters validate()
                  // and the Go side both allow.
                  value={username()}
                  onInput={(e) => setUsername(e.currentTarget.value)}
                />
              </span>
            </label>

            {/* There is nothing to configure. Every connection is gated by a
                code generated for that one attempt, so there is no stored PIN
                to set, to forget, or to leave switched off. */}
            <div class="settings-row">
              <div class="settings-row-main">
                <div class="settings-row-label">Connections always need a code</div>
                <div class="settings-row-hint">
                  Whoever wants to share reads an 8-character code off their screen, and you type
                  it here to let them in. A fresh one is generated every time, and this device
                  never sees it until you enter it — so nothing can connect without a person on
                  both ends. You are still asked separately before anything is saved.
                </div>
              </div>
            </div>
          </div>

          <Show when={error()}>
            <div class="env-modal-error">{error()}</div>
          </Show>

          <div class="modal-footer">
            <button class="btn-cancel" type="button" onClick={close}>
              Cancel
            </button>
            <button class="btn-primary" type="button" onClick={handleSave}>
              Save
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
