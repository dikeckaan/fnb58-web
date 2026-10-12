import { describe, expect, it } from 'vitest';
import { MeterModel, type Scenario } from '../device/simulator';
import {
  allanDeviation, batteryLifeHours, busStates, chargeForecast, compareFingerprints, dutyProfile, fingerprint,
  viDensity, voltageTransitions,
} from './lab';
import { SampleStore } from './sampleStore';
import { runScript, type ScriptEvent, type ScriptHost } from './script';

function build(n: number, f: (t: number, k: number) => Partial<{ v: number; i: number; dp: number; dn: number }>): SampleStore {
  const s = new SampleStore();
  for (let k = 0; k < n; k++) {
    const x = f(k * 0.01, k);
    s.push(k * 0.01, x.v ?? 5, x.i ?? 0, x.dp ?? 0, x.dn ?? 0, 25);
  }
  return s;
}

function simulate(scenario: Scenario, seconds: number, seed = 58): SampleStore {
  const m = new MeterModel(scenario, seed);
  const s = new SampleStore();
  for (let k = 0; k < seconds * 100; k++) {
    const r = m.next();
    s.push(k * 0.01, r.voltage, r.current, r.dp, r.dn, r.temp);
  }
  return s;
}

/** Deterministic noise in [-1, 1). */
function noise(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 2147483648 - 1;
  };
}

describe('dutyProfile', () => {
  // 200 µA asleep, 40 mA for 0.2 s every 2 s.
  const s = build(4000, (t) => ({ i: t % 2 < 0.2 ? 0.04 : 0.0002 }));
  const d = dutyProfile(s, 0, s.length)!;

  it('separates the sleep floor from wake events', () => {
    expect(d.sleep).toBeCloseTo(0.0002, 5);
    expect(d.active).toBeCloseTo(0.04, 4);
    expect(d.duty).toBeCloseTo(0.1, 2);
    expect(d.period).toBeCloseTo(2, 2);
    expect(d.activeTime).toBeCloseTo(0.2, 2);
  });

  it('averages over whole cycles', () => {
    expect(d.average).toBeCloseTo(0.1 * 0.04 + 0.9 * 0.0002, 3);
    // 39.8 mA above the floor for 0.2 s.
    expect(d.chargePerEvent).toBeCloseTo(0.0398 * 0.2, 3);
    expect(d.energyPerEvent).toBeCloseTo(0.0398 * 0.2 * 5, 2);
  });

  it('declines a steady load', () => {
    const flat = build(2000, () => ({ i: 0.5 }));
    expect(dutyProfile(flat, 0, flat.length)).toBeNull();
  });

  it('reads the simulated sensor node', () => {
    const iot = simulate('iot', 40);
    const p = dutyProfile(iot, 0, iot.length)!;
    expect(p.period).toBeCloseTo(4, 1);
    expect(p.sleep).toBeGreaterThan(0.0002);
    expect(p.sleep).toBeLessThan(0.0006);
    expect(p.peak).toBeGreaterThan(0.1);
  });
});

describe('batteryLifeHours', () => {
  it('divides usable capacity by the drain', () => {
    expect(batteryLifeHours(0.001, { capacityMah: 1000, usable: 1, selfDischargePct: 0 })).toBeCloseTo(1000, 6);
    expect(batteryLifeHours(0.001, { capacityMah: 1000, usable: 0.8, selfDischargePct: 0 })).toBeCloseTo(800, 6);
  });

  it('counts self-discharge as extra drain', () => {
    // 2 %/month of 1000 mAh is 20 mAh per 720 h, about 27.8 µA.
    const h = batteryLifeHours(0.0001, { capacityMah: 1000, usable: 1, selfDischargePct: 2 });
    expect(h).toBeCloseTo(1 / (0.0001 + 0.02 / 720), 3);
  });
});

describe('chargeForecast', () => {
  it('reports constant current before the taper', () => {
    const s = build(6000, () => ({ i: 2 }));
    expect(chargeForecast(s, 0, s.length, 0.1)!.phase).toBe('cc');
  });

  it('recovers the time constant of the tail and the time left', () => {
    // 2 A for 60 s, then decay with tau = 50 s. Watch for 70 s of tail.
    const s = build(13000, (t) => ({ i: t < 60 ? 2 : 2 * Math.exp(-(t - 60) / 50) }));
    const f = chargeForecast(s, 0, s.length, 0.1)!;
    expect(f.phase).toBe('cv');
    expect(f.tau!).toBeCloseTo(50, 0);
    expect(f.r2!).toBeGreaterThan(0.99);
    const now = 2 * Math.exp(-70 / 50);
    expect(f.now).toBeCloseTo(now, 1);
    expect(f.eta!).toBeCloseTo(50 * Math.log(now / 0.1), -1);
    expect(f.remainingAh!).toBeCloseTo((50 * (now - 0.1)) / 3600, 3);
  });

  it('survives the charging pauses of the simulated phone', () => {
    const s = simulate('phone', 260);
    const f = chargeForecast(s, 0, s.length, 0.1)!;
    expect(f.phase).toBe('cv');
    expect(f.tau!).toBeGreaterThan(45);
    expect(f.tau!).toBeLessThan(65);
  });

  it('says done below the termination current', () => {
    const s = build(40000, (t) => ({ i: t < 60 ? 2 : 2 * Math.exp(-(t - 60) / 50) }));
    const f = chargeForecast(s, 0, s.length, 0.1)!;
    expect(f.phase).toBe('done');
    expect(f.eta).toBe(0);
  });
});

describe('allanDeviation', () => {
  it('falls as one over root tau for white noise', () => {
    const r = noise(7);
    const x = Float64Array.from({ length: 16384 }, () => r());
    const a = allanDeviation(x, 0, x.length, 100)!;
    expect(a.slope).toBeCloseTo(-0.5, 1);
    // Uniform noise in [-1, 1) has sigma 1/sqrt(3); ADEV at one sample equals sigma.
    expect(a.adev[0]).toBeCloseTo(1 / Math.sqrt(3), 1);
  });

  it('finds the averaging time where drift starts to win', () => {
    const r = noise(11);
    const x = Float64Array.from({ length: 16384 }, (_, k) => r() * 0.01 + k * 2e-6);
    const a = allanDeviation(x, 0, x.length, 100)!;
    expect(a.best.tau).toBeGreaterThan(0.5);
    expect(a.best.tau).toBeLessThan(a.tau[a.tau.length - 1]);
    expect(a.adev[a.adev.length - 1]).toBeGreaterThan(a.best.adev * 2);
  });

  it('needs enough samples', () => {
    expect(allanDeviation(new Float64Array(10), 0, 10, 100)).toBeNull();
  });
});

describe('busStates', () => {
  it('reads a Quick Charge handshake as a sequence', () => {
    const s = simulate('phone', 12);
    const ids = busStates(s, 0, s.length).map((x) => x.id);
    expect(ids).toEqual(['dcp', 'qc2_5', 'qc2_9']);
  });

  it('drops single-sample glitches', () => {
    const s = build(600, (_, k) => (k === 300 ? { dp: 3.3, dn: 3.3 } : { dp: 0.6, dn: 0.6 }));
    expect(busStates(s, 0, s.length).map((x) => x.id)).toEqual(['dcp']);
  });
});

describe('voltageTransitions', () => {
  it('measures a 5 V to 9 V ramp', () => {
    // 4 V in 0.2 s is 20 V/s.
    const s = build(1000, (t) => ({ v: t < 3 ? 5 : t < 3.2 ? 5 + (t - 3) * 20 : 9 }));
    const tr = voltageTransitions(s, 0, s.length);
    expect(tr).toHaveLength(1);
    expect(tr[0].from).toBeCloseTo(5, 1);
    expect(tr[0].to).toBeCloseTo(9, 1);
    expect(tr[0].slew).toBeCloseTo(20, -1);
    expect(tr[0].overshoot).toBeLessThan(0.01);
  });

  it('reports overshoot', () => {
    const s = build(1000, (t) => ({ v: t < 3 ? 5 : t < 3.1 ? 5 + (t - 3) * 46 : t < 3.3 ? 9.6 - (t - 3.1) * 3 : 9 }));
    const [tr] = voltageTransitions(s, 0, s.length);
    expect(tr.overshoot).toBeGreaterThan(0.4);
    expect(tr.overshoot).toBeLessThan(0.7);
  });

  it('ignores ripple', () => {
    const s = build(1000, (t) => ({ v: 5 + 0.05 * Math.sin(t * 40) }));
    expect(voltageTransitions(s, 0, s.length)).toEqual([]);
  });
});

describe('fingerprint', () => {
  const supply = (voc: number, rs: number, rippleHz: number, rippleV: number, seed: number) => {
    const r = noise(seed);
    return build(4096, (t) => {
      const i = 1 + 0.5 * Math.sign(Math.sin(t * 1.3));
      return { v: voc - rs * i + rippleV * Math.sin(2 * Math.PI * rippleHz * t) + r() * 0.0005, i, dp: 2.7, dn: 2.7 };
    });
  };

  it('extracts the load line, ripple and signature', () => {
    const s = supply(5.1, 0.08, 12.5, 0.01, 1);
    const f = fingerprint(s, 0, s.length)!;
    expect(f.voc!).toBeCloseTo(5.1, 2);
    expect(f.rs!).toBeCloseTo(0.08, 2);
    expect(f.ripple).toBeCloseTo(0.01 / Math.SQRT2, 3);
    expect(f.line!).toBeCloseTo(12.5, 1);
    expect(f.guess).toBe('apple24');
  });

  it('scores the same supply high and a different one low', () => {
    const a = fingerprint(supply(5.1, 0.08, 12.5, 0.01, 1), 0, 4096)!;
    const again = fingerprint(supply(5.1, 0.08, 12.5, 0.01, 2), 0, 4096)!;
    const other = fingerprint(supply(4.85, 0.3, 31, 0.04, 3), 0, 4096)!;
    expect(compareFingerprints(a, again).score).toBeGreaterThan(95);
    expect(compareFingerprints(a, other).score).toBeLessThan(50);
  });

  it('skips traits a steady load cannot reveal', () => {
    const flat = build(1000, () => ({ v: 5, i: 1 }));
    const f = fingerprint(flat, 0, flat.length)!;
    expect(f.rs).toBeNull();
    const c = compareFingerprints(f, f);
    expect(c.traits.find((x) => x.id === 'rs')!.score).toBeNull();
    expect(c.score).toBeCloseTo(100, 6);
  });

  it('needs a live bus', () => {
    const dead = build(1000, () => ({ v: 0 }));
    expect(fingerprint(dead, 0, dead.length)).toBeNull();
  });
});

describe('viDensity', () => {
  it('counts every sample once and peaks where the load dwells', () => {
    const s = build(1000, (_, k) => (k < 900 ? { v: 5, i: 1 } : { v: 4.8, i: 2 }));
    const d = viDensity(s, 0, s.length, 32, 32)!;
    expect(d.counts.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(d.max).toBe(900);
    expect(d.i0).toBeLessThan(1);
    expect(d.i1).toBeGreaterThan(2);
  });
});

describe('runScript', () => {
  const reading = { t: 0, v: 9, i: 1, p: 9, dp: 3.3, dn: 0.6, temp: 30 };
  const host = (over: Partial<ScriptHost> = {}): ScriptHost => ({
    read: () => reading,
    mean: () => ({ ...reading, vpp: 0.01, ipp: 0.01, samples: 100 }),
    trigger: async () => true,
    release: async () => undefined,
    startRecording: () => undefined,
    stopRecording: () => undefined,
    resetCounters: () => undefined,
    counters: () => ({ ah: 0, wh: 0, elapsed: 0 }),
    ...over,
  });
  const run = async (code: string, h = host(), signal = new AbortController().signal) => {
    const events: ScriptEvent[] = [];
    const result = await runScript(code, h, (e) => events.push(e), signal);
    return { events, result };
  };

  it('logs, tabulates and passes', async () => {
    const { events, result } = await run(`
      const r = read();
      log('vbus', r.v);
      row('9 V', r.v, r.i);
      near(r.v, 9, 0.5, 'level');
    `);
    expect(result).toEqual({ verdict: 'pass', checks: 1, failed: 0 });
    expect(events.map((e) => e.kind)).toEqual(['log', 'row', 'pass']);
    expect(events[0].text).toBe('vbus 9');
    expect(events[1].cells).toEqual(['9 V', 9, 1]);
  });

  it('fails when a check does not hold', async () => {
    const { result } = await run(`check(read().v > 12, 'above 12 V'); check(true, 'fine');`);
    expect(result).toEqual({ verdict: 'fail', checks: 2, failed: 1 });
  });

  it('passes trigger requests to the host', async () => {
    const calls: [string, number][] = [];
    const { result } = await run(`check(await trigger('qc2', 9), 'accepted'); await release();`, host({
      trigger: async (p, v) => {
        calls.push([p, v]);
        return true;
      },
    }));
    expect(calls).toEqual([['qc2', 9]]);
    expect(result.verdict).toBe('pass');
  });

  it('releases a held voltage when the script fails or is stopped', async () => {
    let released = 0;
    const h = () => host({ release: async () => void released++ });
    await run(`await trigger('qc2', 9); throw new Error('boom');`, h());
    expect(released).toBe(1);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await run(`await trigger('qc2', 9); await sleep(30);`, h(), ac.signal);
    expect(released).toBe(2);
    // A script that ends normally keeps the level it asked for.
    await run(`await trigger('qc2', 9);`, h());
    expect(released).toBe(2);
  });

  it('reports a thrown error without a verdict', async () => {
    const { events, result } = await run(`throw new Error('boom');`);
    expect(result.verdict).toBe('error');
    expect(result.error).toBe('boom');
    expect(events[events.length - 1]).toEqual({ kind: 'error', text: 'boom' });
  });

  it('reports syntax errors', async () => {
    const { result } = await run(`const = 3;`);
    expect(result.verdict).toBe('error');
  });

  it('explains a missing data source', async () => {
    const { result } = await run(`read();`, host({ read: () => null }));
    expect(result.error).toMatch(/connect the meter/);
  });

  it('stops in the middle of a wait', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const { result, events } = await run(`await sleep(30); log('never');`, host(), ac.signal);
    expect(result.verdict).toBe('stopped');
    expect(events).toEqual([]);
  });

  it('waits for a condition and times out', async () => {
    const { result } = await run(`check(await waitFor((r) => r.v > 8, 1), 'reached'); check(!(await waitFor((r) => r.v > 20, 0.1)), 'timed out');`);
    expect(result).toEqual({ verdict: 'pass', checks: 2, failed: 0 });
  });
});
