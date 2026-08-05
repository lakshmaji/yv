import { setSettingsModalOpen } from '../../store';

/**
 * Shown when metrics collection is switched off. It explains why the dashboard
 * is empty and offers the one action that fixes it, rather than looking broken.
 */
export default function DashboardEmptyState() {
  return (
    <div class="dash-empty">
      <div class="dash-empty-icon">▤</div>
      <div class="dash-empty-title">Usage metrics are off</div>
      <p class="dash-empty-text">
        Nothing is being recorded, and nothing is written to disk. Turn collection on to start
        charting memory and CPU use per command, project, or group, and to build up a daily
        activity calendar.
      </p>
      <button type="button" class="dash-empty-btn" onClick={() => setSettingsModalOpen(true)}>
        Open Settings <kbd>⌘,</kbd>
      </button>
    </div>
  );
}
