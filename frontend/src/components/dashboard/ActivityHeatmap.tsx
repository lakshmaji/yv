import { createMemo, createSignal, For, Show } from 'solid-js';
import type { ActivityHeatmap as ActivityHeatmapData } from '../../types';
import { buildHeatmapGrid, cellTooltip, HEAT_COLORS, type HeatCell } from '../../lib/heatmap';

interface Props {
  data: ActivityHeatmapData | null;
}

// Only alternating weekdays are labelled, as GitHub does — seven labels at this
// cell size would not fit.
const WEEKDAYS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

export default function ActivityHeatmap(props: Props) {
  const [hovered, setHovered] = createSignal<string>('');

  const grid = createMemo(() => buildHeatmapGrid(props.data?.days ?? [], new Date(), 365));

  // One delegated handler for the whole grid rather than 365 listeners.
  function handlePointerOver(e: PointerEvent | FocusEvent) {
    const el = (e.target as HTMLElement)?.closest<HTMLElement>('.heat-cell');
    setHovered(el?.dataset.tip ?? '');
  }

  return (
    <div class="dash-card">
      <div class="dash-card-header">
        <div class="dash-card-title">Activity</div>
        <div class="heat-summary">
          {grid().totalRuns} runs · {grid().activeDays} active days in the last year
        </div>
      </div>

      <div
        class="heatmap-scroll"
        onPointerOver={handlePointerOver}
        onFocusIn={handlePointerOver}
        onPointerLeave={() => setHovered('')}
      >
        {/* One column per week, sized in fractions to match the grid below —
            the weeks stretch to fill the card, so a fixed column width here
            would drift further out of alignment the wider the panel got. */}
        <div
          class="heat-months"
          style={{
            // minmax mirrors the weeks' `flex: 1 1 0; min-width: 9px`, so the
            // labels stay aligned when a narrow window makes the grid scroll
            // rather than shrink.
            'grid-template-columns': `repeat(${grid().weeks.length}, minmax(9px, 1fr))`,
          }}
        >
          <For each={grid().monthLabels}>
            {(m) => (
              <span class="heat-month" style={{ 'grid-column': `${m.col + 1}` }}>
                {m.label}
              </span>
            )}
          </For>
        </div>

        <div class="heat-body">
          <div class="heat-weekdays">
            <For each={WEEKDAYS}>{(d) => <span class="heat-weekday">{d}</span>}</For>
          </div>

          <div class="heatmap">
            <For each={grid().weeks}>
              {(week) => (
                <div class="heat-week">
                  <For each={week}>
                    {(cell) => (
                      <Show when={cell} fallback={<span class="heat-cell heat-pad" />}>
                        {(c) => <HeatCellView cell={c()} />}
                      </Show>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>

      <div class="heat-footer">
        <div class="heat-tip">{hovered()}</div>
        <div class="heat-legend">
          <span>Less</span>
          <For each={HEAT_COLORS}>
            {(color) => <span class="heat-cell" style={{ background: color }} />}
          </For>
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

function HeatCellView(props: { cell: HeatCell }) {
  const tip = () => cellTooltip(props.cell);
  return (
    <span
      class={`heat-cell heat-l${props.cell.level}`}
      data-tip={tip()}
      title={tip()}
      tabindex="0"
      role="img"
      aria-label={tip()}
    />
  );
}
