import { createEffect, createSignal, For, Show } from 'solid-js';
import { appSettings, setAppSettings, settingsModalOpen, setSettingsModalOpen } from '../../store';
import { go } from '../../wails';
import { PANELS, togglePanel } from '../../lib/dashboardPanels';
import { addClips, clipLabel } from '../../lib/audio';
import { formatBytes } from '../../lib/utils';
import type { AppSettings, MetricsStorageInfo, PanelId } from '../../types';

// Mirrors internal/settings.MinRetentionDays / MaxRetentionDays, which is the
// enforcement point.
const MIN_RETENTION = 1;
const MAX_RETENTION = 3650;

export default function SettingsModal() {
  const [enabled, setEnabled] = createSignal(false);
  const [retention, setRetention] = createSignal('365');
  const [panels, setPanels] = createSignal<PanelId[]>([]);
  const [soundOn, setSoundOn] = createSignal(true);
  const [clips, setClips] = createSignal<string[]>([]);
  const [storage, setStorage] = createSignal<MetricsStorageInfo | null>(null);
  const [confirmClear, setConfirmClear] = createSignal(false);
  const [error, setError] = createSignal('');

  // Snapshot on open so Cancel discards cleanly.
  createEffect(() => {
    if (!settingsModalOpen()) return;

    const current = appSettings();
    setEnabled(current.metricsEnabled);
    setRetention(String(current.retentionDays));
    setPanels([...(current.panels || [])]);
    setSoundOn(!current.soundMuted);
    setClips([...(current.audioClips || [])]);
    setConfirmClear(false);
    setError('');

    void refreshStorage();
  });

  async function refreshStorage() {
    try {
      setStorage(await go.GetMetricsStorageInfo());
    } catch {
      setStorage(null);
    }
  }

  function close() {
    setSettingsModalOpen(false);
    setError('');
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
      soundMuted: !soundOn(),
      audioClips: clips(),
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
    setClips(clips().filter((p) => p !== path));
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

            <div class="settings-row">
              <div class="settings-row-main">
                <div class="settings-row-label">Sound clips</div>
                <div class="settings-row-hint">
                  {clips().length === 0
                    ? 'None yet — the dinosaurs are silent until you add some.'
                    : `${clips().length} clip${clips().length === 1 ? '' : 's'} in the pool.`}
                </div>
              </div>
              <button type="button" onClick={handleAddClips}>
                + Add clips…
              </button>
            </div>

            <Show when={clips().length > 0}>
              <div class="settings-clip-list">
                <For each={clips()}>
                  {(path) => (
                    <div class="settings-clip-row">
                      {/* The basename is what identifies a clip at a glance; the
                          full path is one hover away when two share a name. */}
                      <span class="settings-clip-name" title={path}>
                        {clipLabel(path)}
                      </span>
                      <button
                        type="button"
                        class="settings-clip-remove"
                        title="Remove this clip"
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
