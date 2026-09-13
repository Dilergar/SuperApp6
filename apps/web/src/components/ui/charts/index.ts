// Кит графиков (SVG/HTML без зависимостей). Цвета — токены `--series-1…6`, у каждого
// графика таблица-дублёр, числа и даты форматирует вызывающий (`useFormatters`).
export { ChartFrame, type ChartTable } from './ChartFrame';
export { LineChart, type LineChartProps, type LineSeries } from './LineChart';
export { BarChart, type BarChartProps, type BarRow } from './BarChart';
export { StackedBars, type StackedBarsProps, type StackSegment } from './StackedBars';
export { FunnelChart, type FunnelChartProps, type FunnelStepView } from './FunnelChart';
export { CohortGrid, type CohortGridProps, type CohortRowView } from './CohortGrid';
export { ScatterLabeled, type ScatterLabeledProps, type ScatterPoint } from './ScatterLabeled';
export { Sparkline } from './Sparkline';
export { SERIES_SLOTS, SeriesKey, seriesColor, seriesMarker, niceTicks } from './chart-utils';
