import type { Channel, SampleStore } from './sampleStore';

export interface RangeStats {
  count: number;
  duration: number;
  min: number;
  max: number;
  mean: number;
  /** Peak-to-peak, i.e. max minus min. */
  pp: number;
  /** Standard deviation around the mean (AC RMS). */
  std: number;
}

export function channelStats(store: SampleStore, ch: Channel, from = 0, to = store.length): RangeStats {
  const a = store.channel(ch);
  const n = Math.max(0, to - from);
  if (!n) return { count: 0, duration: 0, min: NaN, max: NaN, mean: NaN, pp: NaN, std: NaN };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let k = from; k < to; k++) {
    const x = a[k];
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
  }
  const mean = sum / n;
  let sq = 0;
  for (let k = from; k < to; k++) {
    const d = a[k] - mean;
    sq += d * d;
  }
  return {
    count: n, duration: store.t[to - 1] - store.t[from], min, max, mean,
    pp: max - min, std: Math.sqrt(sq / n),
  };
}

export interface Integral {
  /** Charge in amp-hours. */
  ah: number;
  /** Energy in watt-hours. */
  wh: number;
}

/** Trapezoidal integration of current and power over [from, to). */
export function integrate(store: SampleStore, from = 0, to = store.length): Integral {
  let as = 0;
  let ws = 0;
  for (let k = from + 1; k < to; k++) {
    const dt = store.t[k] - store.t[k - 1];
    as += ((store.i[k] + store.i[k - 1]) / 2) * dt;
    ws += ((store.p[k] + store.p[k - 1]) / 2) * dt;
  }
  return { ah: as / 3600, wh: ws / 3600 };
}

/** Running min/max/mean that never rescans history. */
export class RunningStats {
  count = 0;
  min = Infinity;
  max = -Infinity;
  private sum = 0;

  add(x: number): void {
    this.count++;
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
    this.sum += x;
  }

  get mean(): number {
    return this.count ? this.sum / this.count : NaN;
  }

  reset(): void {
    this.count = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.sum = 0;
  }
}
