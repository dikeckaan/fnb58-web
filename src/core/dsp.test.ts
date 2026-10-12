import { describe, expect, it } from 'vitest';
import { fft, fullStats, histogram, linearFit, loadSteps, pulseShape, sampleRate, spectralPeaks, spectrum, thevenin } from './dsp';
import { SampleStore } from './sampleStore';

function build(n: number, f: (k: number, t: number) => [number, number]): SampleStore {
  const s = new SampleStore();
  for (let k = 0; k < n; k++) {
    const [v, i] = f(k, k * 0.01);
    s.push(k * 0.01, v, i, 0, 0, 25);
  }
  return s;
}

describe('fft', () => {
  it('puts a cosine in the right bin', () => {
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let k = 0; k < n; k++) re[k] = Math.cos((2 * Math.PI * 5 * k) / n);
    fft(re, im);
    expect(Math.hypot(re[5], im[5])).toBeCloseTo(n / 2, 6);
    expect(Math.hypot(re[6], im[6])).toBeLessThan(1e-9);
  });
});

describe('spectrum', () => {
  it('recovers frequency and RMS amplitude of a ripple tone', () => {
    // 5 V DC with 30 mV peak ripple at 12.5 Hz, sampled at 100 Hz.
    const s = build(4096, (_, t) => [5 + 0.03 * Math.sin(2 * Math.PI * 12.5 * t), 1]);
    const sp = spectrum(s.v, 0, s.length, 100)!;
    expect(sp.n).toBe(4096);
    expect(sp.df).toBeCloseTo(100 / 4096, 9);
    const [peak] = spectralPeaks(sp);
    expect(peak.freq).toBeCloseTo(12.5, 2);
    expect(peak.amp).toBeCloseTo(0.03 / Math.SQRT2, 3);
  });

  it('reports no peaks for a clean DC level', () => {
    const s = build(1024, () => [5, 1]);
    expect(spectralPeaks(spectrum(s.v, 0, s.length, 100)!)).toEqual([]);
  });

  it('needs enough samples', () => {
    expect(spectrum(new Float32Array(8), 0, 8, 100)).toBeNull();
  });
});

describe('fullStats', () => {
  it('separates DC and AC and finds the crest factor of a sine', () => {
    const s = build(10000, (_, t) => [0, 2 * Math.sin(2 * Math.PI * 1 * t)]);
    const st = fullStats(s, 'i', 0, s.length)!;
    expect(st.mean).toBeCloseTo(0, 3);
    expect(st.rms).toBeCloseTo(Math.SQRT2, 3);
    expect(st.acRms).toBeCloseTo(Math.SQRT2, 3);
    expect(st.crest).toBeCloseTo(Math.SQRT2, 2);
    expect(st.pp).toBeCloseTo(4, 2);
    expect(st.median).toBeCloseTo(0, 1);
    // d/dt of 2 sin(2 pi t) peaks at 4 pi.
    expect(st.maxSlew).toBeCloseTo(4 * Math.PI, 0);
  });
});

describe('histogram', () => {
  it('counts every sample once', () => {
    const s = build(1000, (k) => [5 + (k % 10) / 100, 1]);
    const h = histogram(s.v, 0, s.length, 20)!;
    expect(Array.from(h.counts).reduce((a, b) => a + b, 0)).toBe(1000);
    expect(h.width).toBeCloseTo(0.09 / 20, 6);
  });

  it('handles a constant signal', () => {
    const h = histogram(new Float32Array(100).fill(5), 0, 100)!;
    expect(h.counts[0]).toBe(100);
  });
});

describe('source model', () => {
  it('recovers open-circuit voltage and series resistance', () => {
    // 5.1 V source behind 120 mOhm, load swept from 0.2 A to 2.2 A.
    const s = build(2000, (k) => {
      const i = 0.2 + (k / 2000) * 2;
      return [5.1 - 0.12 * i, i];
    });
    const th = thevenin(s, 0, s.length)!;
    expect(th.voc).toBeCloseTo(5.1, 3);
    expect(th.rs).toBeCloseTo(0.12, 3);
    expect(th.r2).toBeGreaterThan(0.999);
    expect(th.regulation).toBeCloseTo(((5.1 - 0.12 * 0.2 - (5.1 - 0.12 * 2.2)) / (5.1 - 0.12 * 0.2)) * 100, 1);
  });

  it('declines when the load never changed', () => {
    expect(thevenin(build(500, () => [5, 1]), 0, 500)).toBeNull();
  });

  it('fits a line', () => {
    const f = linearFit([0, 1, 2, 3], [1, 3, 5, 7], 0, 4)!;
    expect(f.slope).toBeCloseTo(2, 9);
    expect(f.intercept).toBeCloseTo(1, 9);
    expect(f.r2).toBeCloseTo(1, 9);
  });
});

describe('loadSteps', () => {
  it('measures droop, settling and output resistance of a load step', () => {
    // At t = 2 s the load jumps 0.5 A -> 2.5 A. Voltage dips 300 mV and
    // recovers with a 40 ms time constant to a level 200 mV lower.
    const s = build(600, (k, t) => {
      const on = k >= 200;
      const dip = on ? -0.3 * Math.exp(-(t - 2) / 0.04) : 0;
      return [5 - (on ? 0.2 : 0) + dip, on ? 2.5 : 0.5];
    });
    const steps = loadSteps(s, 0, s.length, 0.2);
    expect(steps).toHaveLength(1);
    const st = steps[0];
    expect(st.t).toBeGreaterThan(1.95);
    expect(st.t).toBeLessThan(2.05);
    expect(st.iAfter - st.iBefore).toBeCloseTo(2, 2);
    expect(st.vAfter - st.vBefore).toBeCloseTo(-0.2, 2);
    expect(st.rOut).toBeCloseTo(0.1, 2);
    expect(st.transient).toBeLessThan(-0.2);
    expect(st.settle).toBeGreaterThan(0.08);
    expect(st.settle).toBeLessThan(0.25);
  });

  it('finds both edges of a pulse and ignores a steady load', () => {
    const s = build(1000, (k) => [5, k >= 300 && k < 600 ? 2 : 1]);
    expect(loadSteps(s, 0, s.length, 0.2)).toHaveLength(2);
    expect(loadSteps(build(1000, () => [5, 1]), 0, 1000, 0.2)).toEqual([]);
  });
});

describe('pulseShape', () => {
  it('reads duty cycle and frequency of a pulsed load', () => {
    // 2 Hz, 25 % duty between 0.2 A and 1.8 A.
    const s = build(2000, (k) => [5, k % 50 < 12.5 ? 1.8 : 0.2]);
    const p = pulseShape(s.i, 0, s.length, 100)!;
    expect(p.duty).toBeCloseTo(0.26, 2);
    expect(p.freq).toBeCloseTo(2, 2);
    expect(p.high).toBeCloseTo(1.8, 3);
    expect(p.low).toBeCloseTo(0.2, 3);
  });

  it('declines for a ramp', () => {
    expect(pulseShape(build(500, (k) => [5, k / 500]).i, 0, 500, 100)).toBeNull();
  });
});

describe('sampleRate', () => {
  it('measures the actual rate', () => {
    expect(sampleRate(build(1001, () => [5, 1]), 0, 1001)).toBeCloseTo(100, 6);
  });
});
