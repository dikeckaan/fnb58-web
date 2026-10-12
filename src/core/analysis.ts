import type { SampleStore } from './sampleStore';
import { channelStats, integrate, type RangeStats } from './stats';

export interface Analysis {
  duration: number;
  ah: number;
  wh: number;
  v: RangeStats;
  i: RangeStats;
  p: RangeStats;
  temp: RangeStats;
  /** Seconds from the start to the highest power reading. */
  peakPowerAt: number;
  /** Seconds from the start to where current begins its final decline, or null. */
  taperAt: number | null;
  /** Seconds until 80 % of the total energy had been delivered. */
  t80: number | null;
  /** Capacity re-expressed at a 3.7 V nominal cell voltage, in mAh. */
  mah37: number;
}

function quantile(sorted: Float32Array, q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Finds where a charge leaves constant current. The plateau is the upper
 * quartile of current; the taper starts at the last moment current was still
 * within 10 % of it, provided it never returns there afterwards.
 */
export function findTaper(store: SampleStore): number | null {
  const n = store.length;
  if (n < 50) return null;
  const sorted = store.i.slice(0, n).sort();
  const plateau = quantile(sorted, 0.75);
  if (!(plateau > 0.05)) return null;
  const floor = plateau * 0.9;
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (store.i[k] >= floor) {
      last = k;
      break;
    }
  }
  if (last < 0 || last >= n - 1) return null;
  const tail = store.t[n - 1] - store.t[last];
  // A taper is a sustained decline, not a blip at the very end.
  if (tail < Math.max(5, store.duration * 0.05)) return null;
  if (store.i[n - 1] > plateau * 0.7) return null;
  return store.t[last] - store.t[0];
}

export function analyze(store: SampleStore): Analysis {
  const n = store.length;
  const { ah, wh } = integrate(store);
  let peakK = 0;
  for (let k = 1; k < n; k++) if (store.p[k] > store.p[peakK]) peakK = k;

  let t80: number | null = null;
  if (wh > 0) {
    const goal = wh * 3600 * 0.8;
    let ws = 0;
    for (let k = 1; k < n; k++) {
      ws += ((store.p[k] + store.p[k - 1]) / 2) * (store.t[k] - store.t[k - 1]);
      if (ws >= goal) {
        t80 = store.t[k] - store.t[0];
        break;
      }
    }
  }

  return {
    duration: store.duration,
    ah,
    wh,
    v: channelStats(store, 'v'),
    i: channelStats(store, 'i'),
    p: channelStats(store, 'p'),
    temp: channelStats(store, 'temp'),
    peakPowerAt: n ? store.t[peakK] - store.t[0] : 0,
    taperAt: findTaper(store),
    t80,
    mah37: (wh / 3.7) * 1000,
  };
}
