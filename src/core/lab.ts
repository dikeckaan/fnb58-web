// Experiments built on the same 100 samples/s stream: duty-cycle profiling,
// charge forecasting, Allan deviation, bus-state timelines, source fingerprints
// and the V-I density map. Everything here is pure and tested.

import { guessProtocol, type GuessId } from '../device/detector';
import { linearFit, spectralPeaks, spectrum, thevenin } from './dsp';
import type { SampleStore } from './sampleStore';

function quantileOf(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---- Duty-cycle profile and battery life -----------------------------------

export interface DutyProfile {
  /** Mean current while asleep and while awake, in amps. */
  sleep: number;
  active: number;
  /** Level that separates the two states. */
  threshold: number;
  /** Fraction of time spent awake. */
  duty: number;
  /** Complete wake events seen. */
  events: number;
  /** Mean time from one wake-up to the next, or null with fewer than two. */
  period: number | null;
  /** Mean length of one wake event in seconds. */
  activeTime: number;
  /** Charge one wake event costs above the sleep floor, in coulombs. */
  chargePerEvent: number;
  /** Energy one wake event costs above the sleep floor, in joules. */
  energyPerEvent: number;
  /** Highest current seen. */
  peak: number;
  /** Time-weighted mean current over whole cycles where possible. */
  average: number;
  /** Mean voltage over the same stretch. */
  voltage: number;
}

/**
 * Splits a current trace into a sleep floor and wake events. The threshold is
 * the geometric mean of the 10th and 95th percentile, which sits between the
 * two states on the logarithmic scale that sleep currents live on. Returns null
 * when the load does not switch between two clearly different levels.
 */
export function dutyProfile(store: SampleStore, from: number, to: number): DutyProfile | null {
  const n = to - from;
  if (n < 200) return null;
  const sorted = store.i.slice(from, to).sort();
  const lo = Math.max(quantileOf(sorted, 0.1), 1e-5);
  const hi = quantileOf(sorted, 0.95);
  const top = sorted[n - 1];
  // A short wake pulse can sit entirely above the 95th percentile.
  const high = hi > lo * 3 ? hi : top;
  if (!(high > lo * 3) || !(high - lo > 0.0005)) return null;
  const threshold = Math.sqrt(lo * high);
  // Hysteresis keeps noise at the threshold from counting as extra events.
  const up = threshold * 1.15;
  const down = threshold * 0.85;

  let awake = store.i[from] > threshold;
  let firstRise = -1;
  let lastRise = -1;
  let rises = 0;
  let riseAt = -1;
  let events = 0;
  let activeTime = 0;
  for (let k = from + 1; k < to; k++) {
    const x = store.i[k];
    if (!awake && x > up) {
      awake = true;
      riseAt = k;
      if (firstRise < 0) firstRise = k;
      lastRise = k;
      rises++;
    } else if (awake && x < down) {
      awake = false;
      if (riseAt >= 0) {
        events++;
        activeTime += store.t[k] - store.t[riseAt];
      }
    }
  }
  if (!rises) return null;

  // Whole cycles only, so a partial event at either end does not bias the mean.
  const a = rises >= 2 ? firstRise : from;
  const b = rises >= 2 ? lastRise : to - 1;
  let q = 0;
  let e = 0;
  let span = 0;
  let sleepSum = 0;
  let sleepN = 0;
  let activeSum = 0;
  let activeN = 0;
  let vSum = 0;
  for (let k = a + 1; k <= b; k++) {
    const dt = store.t[k] - store.t[k - 1];
    if (!(dt > 0) || dt > 0.5) continue;
    q += ((store.i[k] + store.i[k - 1]) / 2) * dt;
    e += ((store.p[k] + store.p[k - 1]) / 2) * dt;
    span += dt;
  }
  for (let k = a; k <= b; k++) {
    const x = store.i[k];
    vSum += store.v[k];
    if (x > threshold) {
      activeSum += x;
      activeN++;
    } else {
      sleepSum += x;
      sleepN++;
    }
  }
  if (!(span > 0) || !sleepN || !activeN) return null;
  const sleep = sleepSum / sleepN;
  const voltage = vSum / (b - a + 1);
  const cycles = rises >= 2 ? rises - 1 : Math.max(1, events);
  return {
    sleep,
    active: activeSum / activeN,
    threshold,
    duty: activeN / (activeN + sleepN),
    events,
    period: rises >= 2 ? (store.t[lastRise] - store.t[firstRise]) / (rises - 1) : null,
    activeTime: events ? activeTime / events : 0,
    chargePerEvent: Math.max(0, q - sleep * span) / cycles,
    energyPerEvent: Math.max(0, e - sleep * voltage * span) / cycles,
    peak: top,
    average: q / span,
    voltage,
  };
}

export interface BatteryInput {
  /** Rated capacity in mAh. */
  capacityMah: number;
  /** Share of the rated capacity that is usable before cut-off, 0..1. */
  usable: number;
  /** Self-discharge as a percentage of capacity per month. */
  selfDischargePct: number;
}

/** Hours a cell lasts at a mean load, with self-discharge treated as a parallel drain. */
export function batteryLifeHours(averageA: number, b: BatteryInput): number {
  const capacityAh = (b.capacityMah / 1000) * b.usable;
  const leakA = ((b.capacityMah / 1000) * (b.selfDischargePct / 100)) / (30 * 24);
  const drain = averageA + leakA;
  return drain > 0 && capacityAh > 0 ? capacityAh / drain : NaN;
}

// ---- Charge forecast -------------------------------------------------------

export type ChargePhase = 'idle' | 'cc' | 'cv' | 'done';

export interface ChargeForecast {
  phase: ChargePhase;
  /** Constant-current plateau in amps. */
  plateau: number;
  /** Current now, from the fit when tapering. */
  now: number;
  /** Seconds from the start of the range to where the taper began. */
  taperAt: number | null;
  /** Time constant of the exponential tail in seconds. */
  tau: number | null;
  r2: number | null;
  /** Seconds until current reaches the termination level. */
  eta: number | null;
  /** Charge still to come before termination, in Ah. */
  remainingAh: number | null;
  /** Fit in ln(A) against seconds from the range start, for plotting. */
  fit: { slope: number; intercept: number } | null;
  /** Binned tail the fit used: seconds from the range start and ln(A). */
  tailT: number[];
  tailLn: number[];
}

/**
 * Follows a charge through constant current into the constant-voltage tail.
 * In the tail a lithium cell's current decays close to exponentially, so a
 * straight line through ln(I) gives the time constant, and from it the time
 * and charge left until the charger's termination current.
 */
export function chargeForecast(store: SampleStore, from: number, to: number, cutoffA: number, binS = 2): ChargeForecast | null {
  if (to - from < 200) return null;
  const t0 = store.t[from];
  // Upper quartile per bin, so brief charging pauses do not drag a bin down.
  const binT: number[] = [];
  const binI: number[] = [];
  let k = from;
  while (k < to) {
    const end = store.lowerBound(store.t[k] + binS);
    const stop = Math.min(to, Math.max(end, k + 1));
    const part = store.i.slice(k, stop).sort();
    binT.push((store.t[k] + store.t[stop - 1]) / 2 - t0);
    binI.push(quantileOf(part, 0.75));
    k = stop;
  }
  const m = binI.length;
  if (m < 8) return null;
  const plateau = quantileOf(Float64Array.from(binI).sort(), 0.9);
  const last = binI[m - 1];
  const base: ChargeForecast = {
    phase: 'idle', plateau, now: last, taperAt: null, tau: null, r2: null, eta: null, remainingAh: null,
    fit: null, tailT: [], tailLn: [],
  };
  if (!(plateau > 0.05)) return base;

  let lastFlat = -1;
  for (let j = m - 1; j >= 0; j--) {
    if (binI[j] >= plateau * 0.92) {
      lastFlat = j;
      break;
    }
  }
  const tail = m - 1 - lastFlat;
  if (tail < 6 || last > plateau * 0.85) return { ...base, phase: last >= plateau * 0.85 ? 'cc' : 'idle' };

  const tailT: number[] = [];
  const tailLn: number[] = [];
  for (let j = lastFlat + 1; j < m; j++) {
    if (binI[j] > 0.0005) {
      tailT.push(binT[j]);
      tailLn.push(Math.log(binI[j]));
    }
  }
  const fit = linearFit(tailT, tailLn, 0, tailT.length);
  const taperAt = binT[Math.max(0, lastFlat)];
  if (!fit || !(fit.slope < 0)) {
    return { ...base, phase: last <= cutoffA ? 'done' : 'cv', taperAt, tailT, tailLn };
  }
  const tau = -1 / fit.slope;
  const now = Math.exp(fit.intercept + fit.slope * tailT[tailT.length - 1]);
  const done = now <= cutoffA;
  return {
    phase: done ? 'done' : 'cv',
    plateau, now, taperAt, tau, r2: fit.r2,
    eta: done ? 0 : tau * Math.log(now / cutoffA),
    remainingAh: done ? 0 : (tau * (now - cutoffA)) / 3600,
    fit: { slope: fit.slope, intercept: fit.intercept },
    tailT, tailLn,
  };
}

// ---- Allan deviation -------------------------------------------------------

export interface Allan {
  /** Averaging times in seconds. */
  tau: number[];
  /** Overlapping Allan deviation at each averaging time, in the channel's unit. */
  adev: number[];
  /** The averaging time with the lowest deviation. */
  best: { tau: number; adev: number };
  /** Slope of log(adev) against log(tau) over the first decade; -0.5 means white noise. */
  slope: number;
  n: number;
}

/**
 * Overlapping Allan deviation of the newest samples in [from, to). It shows how
 * far averaging helps: the curve falls while noise is white, flattens at the
 * flicker floor, and rises once drift takes over.
 */
export function allanDeviation(x: ArrayLike<number>, from: number, to: number, fs: number, maxN = 65536): Allan | null {
  const n = Math.min(to - from, maxN);
  if (n < 64 || !(fs > 0)) return null;
  const start = to - n;
  const cum = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) cum[k + 1] = cum[k] + x[start + k];
  const tau: number[] = [];
  const adev: number[] = [];
  // Three points per octave keeps the curve smooth without redundant work.
  let prev = 0;
  for (let e = 0; ; e++) {
    const m = Math.round(2 ** (e / 3));
    if (m === prev) continue;
    if (m > n / 4) break;
    prev = m;
    const terms = n - 2 * m + 1;
    let sum = 0;
    for (let k = 0; k < terms; k++) {
      const d = (cum[k + 2 * m] - 2 * cum[k + m] + cum[k]) / m;
      sum += d * d;
    }
    tau.push(m / fs);
    adev.push(Math.sqrt(sum / (2 * terms)));
  }
  if (tau.length < 3) return null;
  let bestK = 0;
  for (let k = 1; k < adev.length; k++) if (adev[k] < adev[bestK]) bestK = k;
  const decade = tau.findIndex((v) => v >= tau[0] * 10);
  const end = decade > 1 ? decade + 1 : Math.min(tau.length, 4);
  const lx = tau.slice(0, end).map(Math.log10);
  const ly = adev.slice(0, end).map((v) => Math.log10(Math.max(v, 1e-12)));
  const fit = linearFit(lx, ly, 0, end);
  return { tau, adev, best: { tau: tau[bestK], adev: adev[bestK] }, slope: fit ? fit.slope : NaN, n };
}

// ---- Bus states and voltage transitions ------------------------------------

export interface BusSegment {
  /** Seconds on the store's time base. */
  t0: number;
  t1: number;
  id: GuessId;
  v: number;
  dp: number;
  dn: number;
}

/**
 * Run-length encodes the data-line signature, which turns a negotiation into a
 * readable sequence. Runs shorter than minDwell are folded into their
 * neighbour, since a single sample caught mid-edge is not a state.
 */
export function busStates(store: SampleStore, from: number, to: number, minDwell = 0.08, limit = 60): BusSegment[] {
  interface Run { a: number; b: number; id: GuessId }
  const runs: Run[] = [];
  for (let k = from; k < to; k++) {
    const id = guessProtocol(store.v[k], store.dp[k], store.dn[k]).id;
    const r = runs[runs.length - 1];
    if (r && r.id === id) r.b = k + 1;
    else runs.push({ a: k, b: k + 1, id });
  }
  const merged: Run[] = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    const dwell = store.t[r.b - 1] - store.t[r.a];
    if (prev && (dwell < minDwell || prev.id === r.id)) prev.b = r.b;
    else merged.push({ ...r });
  }
  // A short opening run belongs to whatever follows it.
  if (merged.length > 1 && store.t[merged[0].b - 1] - store.t[merged[0].a] < minDwell) {
    merged[1].a = merged[0].a;
    merged.shift();
  }
  const out: BusSegment[] = [];
  for (const r of merged) {
    const prev = out[out.length - 1];
    let v = 0;
    let dp = 0;
    let dn = 0;
    // Read levels from the settled second half of the run.
    const mid = r.a + Math.floor((r.b - r.a) / 2);
    for (let k = mid; k < r.b; k++) {
      v += store.v[k];
      dp += store.dp[k];
      dn += store.dn[k];
    }
    const c = r.b - mid;
    const seg = { t0: store.t[r.a], t1: store.t[r.b - 1], id: r.id, v: v / c, dp: dp / c, dn: dn / c };
    if (prev && prev.id === seg.id) {
      prev.t1 = seg.t1;
      prev.v = seg.v;
      prev.dp = seg.dp;
      prev.dn = seg.dn;
    } else out.push(seg);
  }
  return out.slice(-limit);
}

export interface VoltageTransition {
  t: number;
  from: number;
  to: number;
  /** 10 % to 90 % time in seconds. */
  rise: number;
  /** Mean slew between the 10 % and 90 % points, in V/s. */
  slew: number;
  /** Excursion beyond the final level, in volts; zero when there is none. */
  overshoot: number;
}

/** Finds VBUS level changes of at least minStep volts and measures their edges. */
export function voltageTransitions(store: SampleStore, from: number, to: number, minStep = 0.5, rate = 100, limit = 40): VoltageTransition[] {
  const w = Math.max(3, Math.round(rate * 0.1));
  const settle = Math.max(w, Math.round(rate * 1.5));
  const out: VoltageTransition[] = [];
  const mean = (a: number, b: number) => {
    let s = 0;
    for (let k = a; k < b; k++) s += store.v[k];
    return s / (b - a);
  };
  let k = from + w;
  while (k < to - w) {
    if (Math.abs(store.v[k + w - 1] - store.v[k - w]) < minStep) {
      k++;
      continue;
    }
    const before = mean(Math.max(from, k - 3 * w), k - w + 1);
    // Walk forward until the level stops moving.
    let end = k + w;
    const tol = minStep * 0.05;
    const moving = (j: number) => {
      const cur = mean(j, j + w);
      // Still on both sides, so the turning point of an overshoot does not pass for settled.
      return Math.abs(cur - mean(j - w, j)) > tol || (j + 2 * w <= to && Math.abs(mean(j + w, j + 2 * w) - cur) > tol);
    };
    while (end < to - w && end < k + settle && moving(end)) end++;
    const stop = Math.min(to, end + w);
    const after = mean(end, stop);
    const swing = after - before;
    if (Math.abs(swing) < minStep) {
      k = end;
      continue;
    }
    const dir = Math.sign(swing);
    let t10 = NaN;
    let t90 = NaN;
    let extreme = after;
    for (let j = Math.max(from, k - w); j < stop; j++) {
      const frac = (store.v[j] - before) / swing;
      if (Number.isNaN(t10) && frac >= 0.1) t10 = store.t[j];
      if (Number.isNaN(t90) && frac >= 0.9) t90 = store.t[j];
      if ((store.v[j] - extreme) * dir > 0) extreme = store.v[j];
    }
    const rise = Number.isNaN(t10) || Number.isNaN(t90) ? NaN : Math.max(t90 - t10, 1 / rate);
    out.push({
      t: store.t[k], from: before, to: after, rise,
      slew: Number.isFinite(rise) ? (Math.abs(swing) * 0.8) / rise : NaN,
      overshoot: Math.max(0, (extreme - after) * dir),
    });
    k = end + w;
  }
  return out.slice(-limit);
}

// ---- Source fingerprint ----------------------------------------------------

export interface Fingerprint {
  /** Mean VBUS and current while it was taken. */
  v: number;
  i: number;
  /** Open-circuit voltage and series resistance, when the load varied enough. */
  voc: number | null;
  rs: number | null;
  /** RMS of what is left of VBUS after removing the load line, in volts. */
  ripple: number;
  /** Strongest ripple line in Hz, or null without one. */
  line: number | null;
  dp: number;
  dn: number;
  guess: GuessId;
  samples: number;
}

/** Condenses a stretch of data into the traits that tell one supply from another. */
export function fingerprint(store: SampleStore, from: number, to: number, fs = 100): Fingerprint | null {
  const n = to - from;
  if (n < 200) return null;
  let v = 0;
  let i = 0;
  let dp = 0;
  let dn = 0;
  for (let k = from; k < to; k++) {
    v += store.v[k];
    i += store.i[k];
    dp += store.dp[k];
    dn += store.dn[k];
  }
  v /= n;
  i /= n;
  dp /= n;
  dn /= n;
  if (v < 3) return null;
  const th = thevenin(store, from, to);
  const model = th && th.r2 >= 0.5 && th.rs > 0 ? th : null;
  // Residual after the load line, so load changes are not mistaken for ripple.
  const resid = new Float64Array(n);
  let sq = 0;
  for (let k = 0; k < n; k++) {
    const expect = model ? model.voc - model.rs * store.i[from + k] : v;
    resid[k] = store.v[from + k] - expect;
    sq += resid[k] * resid[k];
  }
  const sp = spectrum(resid, 0, n, fs);
  const peak = sp ? spectralPeaks(sp, 1)[0] : undefined;
  return {
    v, i, voc: model ? model.voc : null, rs: model ? model.rs : null,
    ripple: Math.sqrt(sq / n), line: peak ? peak.freq : null,
    dp, dn, guess: guessProtocol(v, dp, dn).id, samples: n,
  };
}

export type TraitId = 'level' | 'rs' | 'ripple' | 'line' | 'dp' | 'dn' | 'guess';

export interface TraitMatch {
  id: TraitId;
  /** 0..1 agreement, or null when either side lacks the trait. */
  score: number | null;
}

export interface Comparison {
  /** 0..100 over the traits both sides have. */
  score: number;
  traits: TraitMatch[];
}

const gauss = (delta: number, tol: number) => Math.exp(-0.5 * (delta / tol) ** 2);

/**
 * Scores how alike two fingerprints are. Each trait is compared against a
 * tolerance that reflects how repeatable it is on this meter, and traits one
 * side could not measure are left out rather than counted as a mismatch.
 */
export function compareFingerprints(a: Fingerprint, b: Fingerprint): Comparison {
  const both = <T,>(x: T | null, y: T | null): [T, T] | null => (x === null || y === null ? null : [x, y]);
  const voc = both(a.voc, b.voc);
  const rs = both(a.rs, b.rs);
  const line = a.line === null && b.line === null ? null : both(a.line, b.line);
  const traits: TraitMatch[] = [
    // Without a load line on both sides, compare loaded levels only when the loads match.
    {
      id: 'level',
      score: voc ? gauss(voc[0] - voc[1], 0.06) : Math.abs(a.i - b.i) < 0.1 ? gauss(a.v - b.v, 0.08) : null,
    },
    { id: 'rs', score: rs ? gauss(Math.log(rs[0] / rs[1]), 0.35) : null },
    { id: 'ripple', score: gauss(Math.log(Math.max(a.ripple, 2e-4) / Math.max(b.ripple, 2e-4)), 0.6) },
    {
      id: 'line',
      score: a.line === null && b.line === null ? null : line ? gauss(line[0] - line[1], 0.4) : 0,
    },
    { id: 'dp', score: gauss(a.dp - b.dp, 0.08) },
    { id: 'dn', score: gauss(a.dn - b.dn, 0.08) },
    { id: 'guess', score: a.guess === b.guess ? 1 : 0 },
  ];
  const scored = traits.filter((x) => x.score !== null);
  const sum = scored.reduce((s, x) => s + (x.score as number), 0);
  return { score: scored.length ? (sum / scored.length) * 100 : 0, traits };
}

// ---- V-I density -----------------------------------------------------------

export interface Density {
  nx: number;
  ny: number;
  /** Row-major counts, row 0 at the lowest voltage. */
  counts: Uint32Array;
  max: number;
  i0: number;
  i1: number;
  v0: number;
  v1: number;
}

/** Bins operating points on the V-I plane, so dwell time shows as density. */
export function viDensity(store: SampleStore, from: number, to: number, nx = 96, ny = 64): Density | null {
  if (to - from < 10) return null;
  let i0 = Infinity;
  let i1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (let k = from; k < to; k++) {
    if (store.i[k] < i0) i0 = store.i[k];
    if (store.i[k] > i1) i1 = store.i[k];
    if (store.v[k] < v0) v0 = store.v[k];
    if (store.v[k] > v1) v1 = store.v[k];
  }
  // Keep a readable window even when the operating point barely moves.
  const padI = Math.max((i1 - i0) * 0.06, 0.01);
  const padV = Math.max((v1 - v0) * 0.06, 0.02);
  i0 = Math.max(0, i0 - padI);
  i1 += padI;
  v0 = Math.max(0, v0 - padV);
  v1 += padV;
  const counts = new Uint32Array(nx * ny);
  let max = 0;
  for (let k = from; k < to; k++) {
    const cx = Math.min(nx - 1, Math.floor(((store.i[k] - i0) / (i1 - i0)) * nx));
    const cy = Math.min(ny - 1, Math.floor(((store.v[k] - v0) / (v1 - v0)) * ny));
    const c = ++counts[cy * nx + cx];
    if (c > max) max = c;
  }
  return { nx, ny, counts, max, i0, i1, v0, v1 };
}
