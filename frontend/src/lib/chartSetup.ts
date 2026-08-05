// Single place where Chart.js is imported and configured.
//
// Following https://www.chartjs.org/docs/latest/getting-started/usage.html:
// import from 'chart.js' rather than 'chart.js/auto' (which disallows
// tree-shaking) and register only the components actually used. Registration
// lives here rather than in each chart component so it happens exactly once
// and no component can forget a controller it depends on.

import {
  Chart,
  BubbleController,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js';
import { CHART_COLORS } from './chartTheme';

Chart.register(
  // Controllers — one per chart type in the dashboard.
  BubbleController, // memory profile
  LineController, // usage frequency
  // Elements the controllers draw with.
  LineElement,
  PointElement,
  // Scales.
  LinearScale,
  CategoryScale,
  // Plugins.
  Filler, // area fills under the frequency lines
  Tooltip,
  Legend,
);

// App-wide defaults, so individual chart configs only declare what differs.
// Chart.js ships light-theme defaults, which are invisible on this background.
Chart.defaults.color = CHART_COLORS.muted;
Chart.defaults.borderColor = CHART_COLORS.border;
Chart.defaults.font.size = 11;
Chart.defaults.maintainAspectRatio = false;

export { Chart };
export type { ChartConfiguration, ScriptableContext, Plugin } from 'chart.js';
