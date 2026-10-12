import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { guessProtocol } from '../device/detector';
import { buildFrame, Cmd, encodeDataFrame, Reply, TRIGGER_PROTOCOLS } from '../device/protocol';
import { MeterModel } from '../device/simulator';
import type { Transport, TransportEvents } from '../device/transport';
import { analyze, findTaper } from './analysis';
import { Engine } from './engine';
import { parseCsv, toCsv } from './exporters';
import { SampleStore } from './sampleStore';
import { SequenceRunner } from './sequence';
import { deleteSession, describeStore, listSessions, loadSession, saveSession, updateSession } from './sessions';
import { channelStats, integrate } from './stats';

function ramp(n: number, f: (k: number) => [number, number]): SampleStore {
  const s = new SampleStore();
  for (let k = 0; k < n; k++) {
    const [v, i] = f(k);
    s.push(k * 0.01, v, i, 0.6, 0.6, 30);
  }
  return s;
}

/** A transport the test drives by hand. */
class FakeTransport implements Transport {
  info = { kind: 'sim' as const, name: 'FNB58' };
  sent: Uint8Array[] = [];
  events!: TransportEvents;
  autoReply: ((frame: Uint8Array) => void) | null = null;
  async open(e: TransportEvents) { this.events = e; }
  async send(f: Uint8Array) { this.sent.push(f); this.autoReply?.(f); }
  async close() {}
}

describe('SampleStore', () => {
  it('grows, then rolls by dropping the oldest quarter', () => {
    const s = new SampleStore({ capacity: 16, maxCapacity: 64, rolling: true });
    for (let k = 0; k < 64; k++) s.push(k, 5, 1, 0, 0, 25);
    expect(s.length).toBe(64);
    s.push(64, 5, 1, 0, 0, 25);
    expect(s.length).toBe(49);
    expect(s.t[0]).toBe(16);
    expect(s.tEnd).toBe(64);
  });

  it('refuses new samples at the ceiling when not rolling', () => {
    const s = new SampleStore({ capacity: 16, maxCapacity: 16 });
    for (let k = 0; k < 16; k++) expect(s.push(k, 5, 1, 0, 0, 25)).toBe(true);
    expect(s.push(16, 5, 1, 0, 0, 25)).toBe(false);
    expect(s.full).toBe(true);
  });

  it('finds indexes by time', () => {
    const s = ramp(100, () => [5, 1]);
    expect(s.lowerBound(0.255)).toBe(26);
    expect(s.nearest(0.254)).toBe(25);
    expect(s.nearest(-5)).toBe(0);
    expect(s.nearest(99)).toBe(99);
  });

  it('stores power as volts times amps', () => {
    const s = ramp(3, () => [9, 2]);
    expect(s.p[1]).toBe(18);
  });
});

describe('stats', () => {
  it('integrates a constant load exactly', () => {
    // 2 A at 5 V for one hour, sampled once a second.
    const s = new SampleStore();
    for (let k = 0; k <= 3600; k++) s.push(k, 5, 2, 0, 0, 25);
    const { ah, wh } = integrate(s);
    expect(ah).toBeCloseTo(2, 9);
    expect(wh).toBeCloseTo(10, 9);
  });

  it('reports ripple as peak-to-peak and standard deviation', () => {
    const s = ramp(1000, (k) => [5 + 0.1 * Math.sin((k / 1000) * 2 * Math.PI * 10), 1]);
    const st = channelStats(s, 'v');
    expect(st.mean).toBeCloseTo(5, 3);
    expect(st.pp).toBeCloseTo(0.2, 2);
    expect(st.std).toBeCloseTo(0.1 / Math.SQRT2, 3);
  });
});

describe('protocol guess', () => {
  it.each([
    [0.2, 1.46, 1.46, 'none'],
    [9.04, 3.3, 0.6, 'qc2_9'],
    [12.1, 0.6, 0.6, 'qc2_12'],
    [20.0, 3.3, 3.3, 'qc2_20'],
    [7.4, 0.6, 3.3, 'qc3'],
    [5.1, 2.7, 2.7, 'apple24'],
    [5.1, 2.7, 2.0, 'apple21'],
    [5.1, 2.0, 2.7, 'apple1'],
    [5.1, 1.2, 1.2, 'samsung2'],
    [20.1, 0.0, 0.0, 'pd'],
    [5.1, 0.6, 0.6, 'dcp'],
    [5.1, 0.0, 0.0, 'idle'],
  ])('%s V, D+ %s, D- %s reads as %s', (v, dp, dn, id) => {
    expect(guessProtocol(v, dp, dn).id).toBe(id);
  });
});

describe('analysis', () => {
  it('finds the constant-current to taper transition', () => {
    // 2 A for 60 s, then exponential decay for 60 s.
    const s = ramp(12000, (k) => [9, k < 6000 ? 2 : 2 * Math.exp(-(k - 6000) / 1500)]);
    const t = findTaper(s)!;
    expect(t).toBeGreaterThan(59);
    expect(t).toBeLessThan(63);
    const a = analyze(s);
    expect(a.t80).toBeGreaterThan(40);
    expect(a.t80).toBeLessThan(70);
    expect(a.mah37).toBeCloseTo((a.wh / 3.7) * 1000, 6);
  });

  it('reports no taper for a steady load', () => {
    expect(findTaper(ramp(5000, () => [5, 1]))).toBeNull();
  });
});

describe('CSV', () => {
  it('round-trips a recording', () => {
    const s = ramp(500, (k) => [5 + k / 1000, 1 + k / 5000]);
    const back = parseCsv(toCsv(s));
    expect(back.length).toBe(500);
    expect(back.v[499]).toBeCloseTo(s.v[499], 4);
    expect(back.i[250]).toBeCloseTo(s.i[250], 4);
    expect(back.t[499]).toBeCloseTo(4.99, 3);
    expect(back.dp[10]).toBeCloseTo(0.6, 3);
  });

  it('reads semicolon files with decimal commas and rebases time', () => {
    const back = parseCsv('Time;Voltage;Current\n10,0;5,10;1,50\n10,5;5,20;1,60\n11,0;5,30;1,70\n');
    expect(back.length).toBe(3);
    expect(back.t[0]).toBe(0);
    expect(back.t[2]).toBe(1);
    expect(back.v[1]).toBeCloseTo(5.2, 5);
  });

  it('rejects files without the needed columns', () => {
    expect(() => parseCsv('a,b\n1,2\n3,4\n')).toThrow('columns');
  });
});

describe('sessions', () => {
  it('saves, lists, loads, renames and deletes', async () => {
    const s = ramp(300, (k) => [9, k / 100]);
    const meta = describeStore(s, { name: 'Test', createdAt: 1000, device: 'FNB58', rate: 100, ah: 0.01, wh: 0.09, source: 'recorded' });
    expect(meta.iMax).toBeCloseTo(2.99, 4);
    await saveSession(meta, s);
    expect((await listSessions()).map((m) => m.id)).toContain(meta.id);
    const back = (await loadSession(meta.id))!;
    expect(back.length).toBe(300);
    expect(back.p[200]).toBeCloseTo(18, 4);
    await updateSession(meta.id, { name: 'Renamed' });
    expect((await listSessions()).find((m) => m.id === meta.id)!.name).toBe('Renamed');
    await deleteSession(meta.id);
    expect(await loadSession(meta.id)).toBeNull();
  });
});

describe('Engine', () => {
  async function connected(clock = { now: 0 }) {
    const engine = new Engine(() => clock.now);
    const tr = new FakeTransport();
    await engine.connect(tr);
    return { engine, tr, clock };
  }

  it('sends the documented handshake', async () => {
    const { engine, tr } = await connected();
    expect(tr.sent.map((f) => f[1])).toEqual([Cmd.Hello, Cmd.Start, Cmd.Start]);
    await engine.disconnect();
  });

  it('counts charge and energy from simulated frames', async () => {
    const { engine, tr, clock } = await connected();
    const frame = encodeDataFrame(Array(4).fill({ voltage: 5, current: 2, dp: 0.6, dn: 0.6, temp: 30 }));
    for (let k = 0; k < 2500; k++) { // 100 s of data
      clock.now = k * 40;
      tr.events.onFrame(frame);
    }
    engine.publish();
    const s = engine.getSnapshot();
    expect(engine.live.length).toBe(10000);
    expect(s.elapsed).toBeCloseTo(99.99, 2);
    expect(s.ah).toBeCloseTo((2 * 99.99) / 3600, 5);
    expect(s.wh).toBeCloseTo((10 * 99.99) / 3600, 5);
    expect(s.now!.v).toBeCloseTo(5, 5);
    expect(s.guess).toBe('dcp');
    expect(s.diag.crcErrors).toBe(0);
    await engine.disconnect();
  });

  it('drops corrupt frames and counts them', async () => {
    const { engine, tr } = await connected();
    const frame = encodeDataFrame(Array(4).fill({ voltage: 5, current: 1, dp: 0, dn: 0, temp: 25 }));
    frame[5] ^= 0xff;
    tr.events.onFrame(frame);
    engine.publish();
    expect(engine.live.length).toBe(0);
    expect(engine.getSnapshot().diag.crcErrors).toBe(1);
    await engine.disconnect();
  });

  it('skips time forward over a silent gap without integrating it', async () => {
    const { engine, tr, clock } = await connected();
    const frame = encodeDataFrame(Array(4).fill({ voltage: 5, current: 2, dp: 0, dn: 0, temp: 25 }));
    for (let k = 0; k < 25; k++) { clock.now = k * 40; tr.events.onFrame(frame); }
    clock.now = 61_000; // a minute of silence
    tr.events.onFrame(frame);
    engine.publish();
    const s = engine.getSnapshot();
    expect(engine.live.tEnd).toBeGreaterThan(60);
    expect(s.diag.gaps).toBe(1);
    expect(s.ah).toBeLessThan((2 * 1.1) / 3600);
    await engine.disconnect();
  });

  it('records at a reduced rate with start and stop conditions', async () => {
    const { engine, tr, clock } = await connected();
    const finished = vi.fn();
    engine.onRecordingFinished = finished;
    const at = (amps: number) => encodeDataFrame(Array(4).fill({ voltage: 5, current: amps, dp: 0, dn: 0, temp: 25 }));
    let k = 0;
    const feed = (amps: number, seconds: number) => {
      for (let n = 0; n < seconds * 25; n++) { clock.now = k++ * 40; tr.events.onFrame(at(amps)); }
    };
    engine.startRecording({ rate: 10, startCurrent: 0.5, stopCurrent: 0.1, stopDelay: 2 });
    feed(0.01, 3);
    engine.publish();
    expect(engine.getSnapshot().rec.state).toBe('armed');
    feed(1, 10);
    engine.publish();
    expect(engine.getSnapshot().rec.state).toBe('recording');
    expect(engine.getSnapshot().rec.samples).toBe(100);
    feed(0.01, 3);
    expect(finished).toHaveBeenCalledTimes(1);
    const rec = finished.mock.calls[0][0];
    expect(rec.rate).toBe(10);
    expect(rec.store.t[0]).toBe(0);
    expect(rec.store.duration).toBeGreaterThan(11.5);
    expect(rec.ah).toBeCloseTo(10 / 3600, 4);
    expect(engine.getSnapshot().rec.state).toBe('idle');
    await engine.disconnect();
  });

  it('raises an alarm once, with hysteresis', async () => {
    const { engine, tr, clock } = await connected();
    const onAlarm = vi.fn();
    engine.onAlarm = onAlarm;
    engine.alarmConfig.iHigh = { enabled: true, limit: 2 };
    const at = (amps: number) => encodeDataFrame(Array(4).fill({ voltage: 5, current: amps, dp: 0, dn: 0, temp: 25 }));
    let k = 0;
    const feed = (amps: number) => { for (let n = 0; n < 10; n++) { clock.now = k++ * 40; tr.events.onFrame(at(amps)); } engine.publish(); };
    feed(1.5);
    expect(engine.getSnapshot().alarms.iHigh).toBe(false);
    feed(2.5);
    feed(2.5);
    expect(engine.getSnapshot().alarms.iHigh).toBe(true);
    expect(onAlarm).toHaveBeenCalledTimes(1);
    feed(1.99); // inside the hysteresis band, stays on
    expect(engine.getSnapshot().alarms.iHigh).toBe(true);
    feed(1.5);
    expect(engine.getSnapshot().alarms.iHigh).toBe(false);
    await engine.disconnect();
  });

  it('resolves a trigger from the meter reply', async () => {
    const { engine, tr } = await connected();
    tr.autoReply = (f) => { if (f[1] === Cmd.Trigger) queueMicrotask(() => tr.events.onFrame(buildFrame(Reply.TriggerOk))); };
    expect(await engine.trigger(TRIGGER_PROTOCOLS[0], 9000)).toBe(true);
    const sent = tr.sent.at(-1)!;
    expect([sent[1], sent[2], sent[3], sent[4]]).toEqual([0x88, 0, 0x28, 0x23]);
    tr.autoReply = (f) => { if (f[1] === Cmd.Trigger) queueMicrotask(() => tr.events.onFrame(buildFrame(Reply.TriggerFail))); };
    expect(await engine.trigger(TRIGGER_PROTOCOLS[0], 12000)).toBe(false);
    tr.autoReply = null;
    expect(await engine.trigger(TRIGGER_PROTOCOLS[0], 12000, 20)).toBe(false); // no reply: times out
    await engine.disconnect();
  });
});

describe('simulator model', () => {
  it('follows a trigger and returns after release', () => {
    const m = new MeterModel('idle');
    for (let k = 0; k < 300; k++) m.next();
    expect(m.next().voltage).toBeCloseTo(5.08, 1);
    expect(m.trigger(0, 12000)).toBe(true);
    for (let k = 0; k < 300; k++) m.next();
    const s = m.next();
    expect(s.voltage).toBeGreaterThan(11.5);
    expect(guessProtocol(s.voltage, s.dp, s.dn).id).toBe('qc2_12');
    m.release();
    for (let k = 0; k < 300; k++) m.next();
    expect(m.next().voltage).toBeLessThan(5.3);
    expect(m.trigger(9, 5000)).toBe(false);
  });

  it('phone scenario negotiates up to 9 V', () => {
    const m = new MeterModel('phone');
    let s = m.next();
    for (let k = 0; k < 1000; k++) s = m.next();
    expect(s.voltage).toBeGreaterThan(8.7);
    expect(s.current).toBeGreaterThan(1.8);
  });
});

describe('SequenceRunner', () => {
  it('runs steps in order, retries once, and releases at the end', async () => {
    const calls: string[] = [];
    let failNext = true;
    const host = {
      trigger: async (p: { id: string }, mv: number) => {
        calls.push(`${p.id}:${mv}`);
        if (failNext) { failNext = false; return false; }
        return true;
      },
      release: async () => { calls.push('release'); },
    };
    const steps = [
      { id: 'a', protocol: 'qc2' as const, millivolts: 9000, holdMs: 1 },
      { id: 'b', protocol: 'qc2' as const, millivolts: 5000, holdMs: 0 },
      { id: 'c', protocol: 'qc3' as const, millivolts: 6000, holdMs: 1 },
    ];
    const onStep = vi.fn();
    const onEnd = vi.fn();
    await new SequenceRunner(host).run(steps, false, { onStep, onEnd });
    expect(calls).toEqual(['qc2:9000', 'qc2:9000', 'qc3:6000', 'release']);
    expect(onStep).toHaveBeenCalledTimes(2);
    expect(onEnd).toHaveBeenCalledWith('finished');
  });

  it('stops on a failed step', async () => {
    const host = { trigger: async () => false, release: async () => {} };
    const onEnd = vi.fn();
    await new SequenceRunner(host).run(
      [{ id: 'a', protocol: 'qc2', millivolts: 9000, holdMs: 5 }], true, { onStep: () => {}, onEnd },
    );
    expect(onEnd).toHaveBeenCalledWith('failed');
  });
});
