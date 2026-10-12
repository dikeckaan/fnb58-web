// Signal analysis for the engineering view. Everything here is pure and tested.
// The meter delivers 100 samples/s, so nothing above 50 Hz is observable and
// faster content (switching ripple, for instance) aliases into this band.

import type { Channel, SampleStore } from './sampleStore';

/** In-place radix-2 FFT. Lengths must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export interface Spectrum {
  /** Bin centre frequencies in Hz, DC excluded. */
  freq: Float64Array;
  /** RMS amplitude of a sinusoid at each bin, in the channel's unit. */
  amp: Float64Array;
  /** Samples used (a power of two). */
  n: number;
  /** Sample rate in Hz. */
  fs: number;
  /** Bin spacing in Hz. */
  df: number;
  /** Equivalent noise bandwidth of the Hann window, in Hz. */
  enbw: number;
}

/**
 * Hann-windowed amplitude spectrum of the newest power-of-two block in
 * [from, to). The mean is removed first so DC does not leak into low bins.
 */
export function spectrum(x: ArrayLike<number>, from: number, to: number, fs: number, maxN = 32768): Spectrum | null {
  const avail = to - from;
  if (avail < 16 || !(fs > 0)) return null;
  let n = 1;
  while (n * 2 <= Math.min(avail, maxN)) n *= 2;
  const start = to - n;
  let mean = 0;
  for (let k = 0; k < n; k++) mean += x[start + k];
  mean /= n;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / n);
    re[k] = (x[start + k] - mean) * w;
  }
  fft(re, im);
  const half = n / 2;
  const freq = new Float64Array(half - 1);
  const amp = new Float64Array(half - 1);
  // Coherent gain of Hann is 0.5: peak = 2|X|/(N*0.5); RMS = peak/sqrt(2).
  const scale = 4 / n / Math.SQRT2;
  for (let k = 1; k < half; k++) {
    freq[k - 1] = (k * fs) / n;
    amp[k - 1] = Math.hypot(re[k], im[k]) * scale;
  }
  return { freq, amp, n, fs, df: fs / n, enbw: (1.5 * fs) / n };
}

export interface Peak {
  freq: number;
  amp: number;
}

/** Strongest spectral lines that stand clear of the noise floor. */
export function spectralPeaks(s: Spectrum, count = 5): Peak[] {
  const sorted = Float64Array.from(s.amp).sort();
  const floor = sorted[Math.floor(sorted.length / 2)] || 0;
  const out: Peak[] = [];
  for (let k = 1; k < s.amp.length - 1; k++) {
    const a = s.amp[k];
    if (a > s.amp[k - 1] && a >= s.amp[k + 1] && a > floor * 8 && a > 0) {
      // Parabolic interpolation recovers frequency between bins.
      const y0 = s.amp[k - 1];
      const y2 = s.amp[k + 1];
      const d = (0.5 * (y0 - y2)) / (y0 - 2 * a + y2 || 1);
      out.push({ freq: s.freq[k] + d * s.df, amp: a });
    }
  }
  return out.sort((p, q) => q.amp - p.amp).slice(0, count);
}

export function medianNoise(s: Spectrum): number {
  const sorted = Float64Array.from(s.amp).sort();
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

export interface FullStats {
  count: number;
  mean: number;
  min: number;
  max: number;
  pp: number;
  /** Root mean square including DC. */
  rms: number;
  /** RMS of the AC part (standard deviation). */
  acRms: number;
  /** Peak over RMS. */
  crest: number;
  median: number;
  p1: number;
  p99: number;
  /** Largest change between neighbouring samples, per second. */
  maxSlew: number;
}

export function fullStats(store: SampleStore, ch: Channel, from: number, to: number): FullStats | null {
  const n = to - from;
  if (n < 2) return null;
  const a = store.channel(ch);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sq = 0;
  let slew = 0;
  for (let k = from; k < to; k++) {
    const x = a[k];
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
    sq += x * x;
    if (k > from) {
      const dt = store.t[k] - store.t[k - 1];
      if (dt > 0 && dt < 0.5) {
        const s = Math.abs(x - a[k - 1]) / dt;
        if (s > slew) slew = s;
      }
    }
  }
  const mean = sum / n;
  const rms = Math.sqrt(sq / n);
  const acRms = Math.sqrt(Math.max(0, sq / n - mean * mean));
  const sorted = a.slice(from, to).sort();
  const q = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.round((n - 1) * p)))];
  return {
    count: n, mean, min, max, pp: max - min, rms, acRms,
    crest: rms > 0 ? Math.max(Math.abs(min), Math.abs(max)) / rms : NaN,
    median: q(0.5), p1: q(0.01), p99: q(0.99), maxSlew: slew,
  };
}

export interface Histogram {
  /** Left edge of each bin. */
  edges: Float64Array;
  counts: Uint32Array;
  width: number;
}

export function histogram(x: ArrayLike<number>, from: number, to: number, bins = 48): Histogram | null {
  if (to - from < 2) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let k = from; k < to; k++) {
    if (x[k] < min) min = x[k];
    if (x[k] > max) max = x[k];
  }
  if (!(max > min)) {
    // All samples equal: one bin, centred.
    return { edges: Float64Array.of(min - 0.5e-5), counts: Uint32Array.of(to - from), width: 1e-5 };
  }
  const width = (max - min) / bins;
  const counts = new Uint32Array(bins);
  for (let k = from; k < to; k++) counts[Math.min(bins - 1, Math.floor((x[k] - min) / width))]++;
  const edges = new Float64Array(bins);
  for (let b = 0; b < bins; b++) edges[b] = min + b * width;
  return { edges, counts, width };
}

export interface Fit {
  slope: number;
  intercept: number;
  r2: number;
  n: number;
}

export function linearFit(x: ArrayLike<number>, y: ArrayLike<number>, from: number, to: number): Fit | null {
  const n = to - from;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let k = from; k < to; k++) {
    sx += x[k];
    sy += y[k];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let k = from; k < to; k++) {
    const dx = x[k] - mx;
    const dy = y[k] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 1, n };
}

export interface Thevenin {
  /** Open-circuit voltage extrapolated to zero current. */
  voc: number;
  /** Series resistance seen by the load, source plus cable up to the meter. */
  rs: number;
  r2: number;
  iMin: number;
  iMax: number;
  /** Voltage change from lightest to heaviest observed load, as a percentage. */
  regulation: number;
}

/**
 * Fits V = Voc - Rs*I over the range. Returns null when the load did not vary
 * enough to say anything about the source.
 */
export function thevenin(store: SampleStore, from: number, to: number): Thevenin | null {
  let iMin = Infinity;
  let iMax = -Infinity;
  for (let k = from; k < to; k++) {
    if (store.i[k] < iMin) iMin = store.i[k];
    if (store.i[k] > iMax) iMax = store.i[k];
  }
  if (!(iMax - iMin > 0.05)) return null;
  const fit = linearFit(store.i, store.v, from, to);
  if (!fit) return null;
  const vLight = fit.intercept + fit.slope * iMin;
  const vHeavy = fit.intercept + fit.slope * iMax;
  return {
    voc: fit.intercept, rs: -fit.slope, r2: fit.r2, iMin, iMax,
    regulation: vLight ? ((vLight - vHeavy) / vLight) * 100 : NaN,
  };
}

export interface LoadStep {
  /** Store time of the edge. */
  t: number;
  iBefore: number;
  iAfter: number;
  vBefore: number;
  vAfter: number;
  /** Furthest voltage excursion past the new steady state, signed. */
  transient: number;
  /** Seconds until voltage stays within the settling band, or null if it never did. */
  settle: number | null;
  /** Static output resistance, -dV/dI. */
  rOut: number;
}

function meanOf(a: ArrayLike<number>, from: number, to: number): number {
  let s = 0;
  for (let k = from; k < to; k++) s += a[k];
  return s / Math.max(1, to - from);
}

/**
 * Finds abrupt current changes and measures the voltage response to each.
 * Windows are in samples and assume about 100 samples/s; `rate` rescales them.
 */
export function loadSteps(store: SampleStore, from: number, to: number, minStep = 0.1, rate = 100, limit = 40): LoadStep[] {
  const w = Math.max(2, Math.round(0.05 * rate)); // 50 ms comparison window
  const pre = Math.max(4, Math.round(0.2 * rate));
  const postFrom = Math.max(4, Math.round(0.3 * rate));
  const postTo = Math.max(8, Math.round(0.8 * rate));
  const spacing = Math.max(4, Math.round(0.3 * rate));
  const out: LoadStep[] = [];
  let k = from + pre;
  while (k < to - postTo && out.length < limit) {
    const d = meanOf(store.i, k + 1, k + 1 + w) - meanOf(store.i, k - w, k);
    if (Math.abs(d) < minStep) {
      k++;
      continue;
    }
    // Slide to the sample where the edge is steepest.
    let best = k;
    let bestD = Math.abs(d);
    for (let j = k + 1; j < Math.min(k + w * 2, to - postTo); j++) {
      const dj = Math.abs(meanOf(store.i, j + 1, j + 1 + w) - meanOf(store.i, j - w, j));
      if (dj > bestD) {
        bestD = dj;
        best = j;
      }
    }
    const e = best;
    const iBefore = meanOf(store.i, e - pre, e - 1);
    const iAfter = meanOf(store.i, e + postFrom, e + postTo);
    const vBefore = meanOf(store.v, e - pre, e - 1);
    const vAfter = meanOf(store.v, e + postFrom, e + postTo);
    const di = iAfter - iBefore;
    if (Math.abs(di) >= minStep * 0.7) {
      let ext = vAfter;
      for (let j = e; j < e + postFrom; j++) {
        if (Math.abs(store.v[j] - vAfter) > Math.abs(ext - vAfter)) ext = store.v[j];
      }
      const band = Math.max(0.01, Math.abs(vAfter - vBefore) * 0.05);
      let settle: number | null = null;
      for (let j = e + postTo - 1; j >= e; j--) {
        if (Math.abs(store.v[j] - vAfter) > band) {
          settle = j + 1 < e + postTo ? store.t[j + 1] - store.t[e] : null;
          break;
        }
        if (j === e) settle = 0;
      }
      out.push({
        t: store.t[e], iBefore, iAfter, vBefore, vAfter,
        transient: ext - vAfter, settle, rOut: -(vAfter - vBefore) / di,
      });
    }
    k = e + spacing;
  }
  return out;
}

export interface Pulse {
  /** Fraction of time the signal spends above its midpoint. */
  duty: number;
  /** Repetition frequency in Hz, or null when not periodic. */
  freq: number | null;
  low: number;
  high: number;
}

/** Describes a two-level (pulsed) signal. Returns null when it is not clearly bimodal. */
export function pulseShape(x: ArrayLike<number>, from: number, to: number, fs: number): Pulse | null {
  const n = to - from;
  if (n < 20) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let k = from; k < to; k++) {
    if (x[k] < min) min = x[k];
    if (x[k] > max) max = x[k];
  }
  const mid = (min + max) / 2;
  const span = max - min;
  let above = 0;
  let near = 0;
  let rises = 0;
  let firstRise = -1;
  let lastRise = -1;
  let lowSum = 0;
  let highSum = 0;
  for (let k = from; k < to; k++) {
    const hi = x[k] > mid;
    if (hi) {
      above++;
      highSum += x[k];
    } else lowSum += x[k];
    if (Math.abs(x[k] - mid) < span * 0.2) near++;
    if (k > from && hi && !(x[k - 1] > mid)) {
      rises++;
      if (firstRise < 0) firstRise = k;
      lastRise = k;
    }
  }
  // Bimodal means few samples sit near the midpoint.
  if (!(span > 0) || near / n > 0.25) return null;
  // A brief dip or spike is an event, not a pulse train.
  const duty = above / n;
  if (duty < 0.03 || duty > 0.97) return null;
  const freq = rises >= 3 ? ((rises - 1) * fs) / (lastRise - firstRise) : null;
  return { duty: above / n, freq, low: lowSum / (n - above), high: highSum / above };
}

/** Actual sample rate of a stretch of data. */
export function sampleRate(store: SampleStore, from: number, to: number): number {
  const span = store.t[to - 1] - store.t[from];
  return to - from > 1 && span > 0 ? (to - from - 1) / span : 0;
}
