// Axis maths shared by every lane. Pure, so it is unit-tested.

const STEPS = [1, 2, 2.5, 5, 10];

/** A round step that yields at most `maxTicks` intervals across `span`. */
export function niceStep(span: number, maxTicks: number): number {
  if (!(span > 0) || maxTicks < 1) return 1;
  const raw = span / maxTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const s of STEPS) if (s * mag >= raw * (1 - 1e-9)) return s * mag;
  return 10 * mag;
}

export function ticks(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  if (!(step > 0) || !(max > min)) return out;
  const first = Math.ceil(min / step - 1e-9) * step;
  for (let x = first; x <= max + step * 1e-9 && out.length < 200; x += step) {
    out.push(Math.abs(x) < step * 1e-9 ? 0 : x);
  }
  return out;
}

/** Digits needed after the decimal point to print multiples of `step` exactly. */
export function decimalsFor(step: number): number {
  if (!(step > 0)) return 0;
  for (let d = 0; d <= 5; d++) {
    const scaled = step * Math.pow(10, d);
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6) return d;
  }
  return 5;
}

const TIME_STEPS = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 43200, 86400,
];

export function niceTimeStep(span: number, maxTicks: number): number {
  const raw = span / Math.max(1, maxTicks);
  for (const s of TIME_STEPS) if (s >= raw) return s;
  return TIME_STEPS[TIME_STEPS.length - 1];
}

export interface YRange {
  min: number;
  max: number;
}

export interface AutoRangeOptions {
  /** Smallest span worth showing; stops noise from filling the lane. */
  minSpan: number;
  /** Never show below zero (all of this meter's channels except temperature). */
  floorZero: boolean;
}

/**
 * Chooses a y-range for the visible data. The previous range is kept while the
 * data still fits it and fills a fair share of it, so a live trace does not
 * rescale on every frame.
 */
export function autoRange(lo: number, hi: number, prev: YRange | null, o: AutoRangeOptions): YRange {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return prev ?? { min: 0, max: o.minSpan };
  const dataSpan = hi - lo;
  if (prev) {
    const span = prev.max - prev.min;
    const margin = span * 0.04;
    const fits = lo >= prev.min + (prev.min === 0 && o.floorZero ? -1 : margin) && hi <= prev.max - margin;
    const fills = Math.max(dataSpan, o.minSpan) >= span * 0.3;
    if (fits && fills) return prev;
  }
  let span = Math.max(dataSpan * 1.3, o.minSpan);
  const mid = (lo + hi) / 2;
  let min = mid - span / 2;
  let max = mid + span / 2;
  if (o.floorZero && min < 0) {
    max -= min;
    min = 0;
  }
  // Snap outward to round numbers so tick labels stay tidy.
  const step = niceStep(span, 4);
  min = Math.floor(min / step + 1e-9) * step;
  max = Math.ceil(max / step - 1e-9) * step;
  if (o.floorZero && min < 0) min = 0;
  // A load that is nearly zero-based reads better anchored at zero.
  if (o.floorZero && min > 0 && min < (max - min) * 0.6) min = 0;
  span = max - min;
  return { min, max: span > 0 ? max : min + o.minSpan };
}
