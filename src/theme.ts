// Colours the canvas needs as literals. The same values live in styles/app.css.
import type { Channel } from './core/sampleStore';
import type { LaneSpec, ScopeTheme } from './plot/scope';

/** Categorical slots, validated for colour-vision deficiency on the panel surface. */
export const SERIES: Record<Channel, string> = {
  v: '#c98500',
  i: '#3987e5',
  p: '#d55181',
  dp: '#199e70',
  dn: '#d95926',
  temp: '#9085e9',
};

export const SCOPE_THEME: ScopeTheme = {
  grid: '#2a3f4f',
  axisText: '#9fb2bf',
  cursor: '#e9c46a',
  hover: '#eaf0f3',
  band: 'rgba(233, 196, 106, 0.10)',
  surface: '#1b2c38',
  font: '11px "Bench Mono", "B612 Mono", ui-monospace, monospace',
};

export type LaneId = 'v' | 'i' | 'p' | 'd' | 'temp';
export const LANE_IDS: LaneId[] = ['v', 'i', 'p', 'd', 'temp'];

export const LANES: Record<LaneId, LaneSpec & { unit: string; digits: number; height: number }> = {
  v: { id: 'v', series: [{ channel: 'v', color: SERIES.v }], minSpan: 0.2, floorZero: true, unit: 'V', digits: 4, height: 112 },
  i: { id: 'i', series: [{ channel: 'i', color: SERIES.i }], minSpan: 0.05, floorZero: true, unit: 'A', digits: 4, height: 112 },
  p: { id: 'p', series: [{ channel: 'p', color: SERIES.p }], minSpan: 0.25, floorZero: true, unit: 'W', digits: 3, height: 112 },
  d: {
    id: 'd',
    // Two series share this lane, so D- is also dashed: identity never rests on colour alone.
    series: [{ channel: 'dp', color: SERIES.dp }, { channel: 'dn', color: SERIES.dn, dash: [6, 4] }],
    minSpan: 0.5, floorZero: true, unit: 'V', digits: 3, height: 84,
  },
  temp: { id: 'temp', series: [{ channel: 'temp', color: SERIES.temp }], minSpan: 4, floorZero: false, unit: '°C', digits: 1, height: 68 },
};
