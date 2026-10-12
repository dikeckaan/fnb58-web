// The one place that owns the meter connection and everything derived from it.
// Sample-rate data lives here in typed arrays; React only sees a small snapshot
// republished a few times a second.

import { GuessSmoother, guessProtocol, type GuessId } from '../device/detector';
import {
  buildFrame, buildReleaseFrame, buildTriggerFrame, Cmd, decodeDataFrame, findModel, frameCrcOk,
  FRAME_HEAD, Reply, SAMPLE_PERIOD_S, toHex, type TriggerProtocol,
} from '../device/protocol';
import type { Transport, TransportInfo } from '../device/transport';
import { SampleStore } from './sampleStore';
import { RunningStats } from './stats';

export type Status = 'disconnected' | 'connecting' | 'connected';
export type RecState = 'idle' | 'armed' | 'recording' | 'paused';
export type AlarmKey = 'vHigh' | 'vLow' | 'iHigh' | 'pHigh' | 'tHigh';
export const ALARM_KEYS: AlarmKey[] = ['vHigh', 'vLow', 'iHigh', 'pHigh', 'tHigh'];

export interface AlarmRule {
  enabled: boolean;
  limit: number;
}
export type AlarmConfig = Record<AlarmKey, AlarmRule>;

export const DEFAULT_ALARMS: AlarmConfig = {
  vHigh: { enabled: false, limit: 21 },
  vLow: { enabled: false, limit: 4.5 },
  iHigh: { enabled: false, limit: 5 },
  pHigh: { enabled: false, limit: 100 },
  tHigh: { enabled: false, limit: 60 },
};

export interface RecordConfig {
  /** Stored samples per second. The meter always measures at 100. */
  rate: 100 | 50 | 10 | 1;
  /** Begin when current rises to this many amps. 0 starts immediately. */
  startCurrent: number;
  /** End when current stays below this many amps. 0 disables. */
  stopCurrent: number;
  /** How long current must stay below stopCurrent, in seconds. */
  stopDelay: number;
}

export const DEFAULT_RECORD: RecordConfig = { rate: 100, startCurrent: 0, stopCurrent: 0, stopDelay: 10 };

export interface Reading {
  v: number;
  i: number;
  p: number;
  dp: number;
  dn: number;
  temp: number;
}

export interface MinMax {
  min: number;
  max: number;
  mean: number;
}

export interface DeviceDetails {
  model: string;
  /** Raw device-info payload, kept for the diagnostics panel. */
  infoHex: string;
  /** Best reading of the firmware field; not confirmed against the vendor tool. */
  firmware: string;
}

export interface LogEntry {
  /** Wall-clock milliseconds. */
  at: number;
  kind: 'connect' | 'disconnect' | 'trigger' | 'triggerFail' | 'release' | 'alarm' | 'recStart' | 'recStop' | 'gap' | 'error';
  detail?: string;
}

export interface Snapshot {
  status: Status;
  transport: TransportInfo | null;
  device: DeviceDetails | null;
  /** Mean of roughly the last quarter second, or null before the first sample. */
  now: Reading | null;
  /** Seconds of data since counters were last reset. */
  elapsed: number;
  ah: number;
  wh: number;
  stats: Record<'v' | 'i' | 'p' | 'temp', MinMax> | null;
  guess: GuessId;
  rec: { state: RecState; samples: number; duration: number; ah: number; wh: number; full: boolean };
  alarms: Record<AlarmKey, boolean>;
  diag: { frames: number; crcErrors: number; gaps: number; rate: number; lastOther: string };
  log: LogEntry[];
}

export interface FinishedRecording {
  store: SampleStore;
  rate: number;
  startedAt: number;
  device: string;
  ah: number;
  wh: number;
}

const LIVE_CAPACITY = 360_000; // one hour at 100 samples/s
const REC_MAX_SAMPLES = 8_640_000; // 24 hours at 100 samples/s
const PUBLISH_MS = 125;
const READOUT_SAMPLES = 25;
const GAP_TOLERANCE_S = 2;
const HYSTERESIS = 0.02;

type Clock = () => number;

export class Engine {
  readonly live = new SampleStore({ capacity: 8192, maxCapacity: LIVE_CAPACITY, rolling: true });
  recStore: SampleStore | null = null;

  alarmConfig: AlarmConfig = structuredClone(DEFAULT_ALARMS);
  recordConfig: RecordConfig = { ...DEFAULT_RECORD };
  onAlarm: ((key: AlarmKey) => void) | null = null;
  onRecordingFinished: ((r: FinishedRecording) => void) | null = null;

  private transport: Transport | null = null;
  private status: Status = 'disconnected';
  private device: DeviceDetails | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private publisher: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private snap: Snapshot;

  // Time base
  private origin = 0; // clock() at first sample
  private sampleCount = 0;
  private gapOffset = 0; // seconds added after dropped data

  // Counters
  private countersAt = 0;
  private as = 0;
  private ws = 0;
  private sV = new RunningStats();
  private sI = new RunningStats();
  private sP = new RunningStats();
  private sT = new RunningStats();

  // Recorder
  private recState: RecState = 'idle';
  private recT0 = 0;
  private recStartedAt = 0;
  private recAs = 0;
  private recWs = 0;
  private recBelowSince = -1;
  private acc = { n: 0, t: 0, v: 0, i: 0, dp: 0, dn: 0, temp: 0 };

  // Diagnostics
  private frames = 0;
  private crcErrors = 0;
  private gaps = 0;
  private lastOther = '';
  private rateWindow: number[] = [];
  private alarms: Record<AlarmKey, boolean> = { vHigh: false, vLow: false, iHigh: false, pHigh: false, tHigh: false };
  private smoother = new GuessSmoother();
  private guess: GuessId = 'none';
  private log: LogEntry[] = [];
  private pendingTrigger: { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly clock: Clock = () => performance.now()) {
    this.snap = this.buildSnapshot();
  }

  // ---- React bridge ------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snap;

  publish(): void {
    this.snap = this.buildSnapshot();
    for (const fn of this.listeners) fn();
  }

  private addLog(kind: LogEntry['kind'], detail?: string): void {
    this.log = [{ at: Date.now(), kind, detail }, ...this.log].slice(0, 200);
  }

  clearLog(): void {
    this.log = [];
    this.publish();
  }

  // ---- Connection --------------------------------------------------------

  get connected(): boolean {
    return this.status === 'connected';
  }

  async connect(transport: Transport): Promise<void> {
    await this.disconnect();
    this.status = 'connecting';
    this.transport = transport;
    this.publish();
    try {
      await transport.open({
        onFrame: (f) => this.handleFrame(f),
        onClose: (reason) => this.handleClose(reason),
      });
      // Set before the handshake so the device-info reply has somewhere to land.
      this.device = { model: transport.info.name, infoHex: '', firmware: '' };
      const model = transport.info.vendorId !== undefined
        ? findModel(transport.info.vendorId, transport.info.productId ?? 0)
        : undefined;
      const fast = model ? model.fastFamily : true;
      await transport.send(buildFrame(Cmd.Hello));
      await transport.send(buildFrame(Cmd.Start));
      await transport.send(buildFrame(fast ? Cmd.Start : Cmd.KeepAlive));
      this.keepAlive = setInterval(() => {
        this.transport?.send(buildFrame(Cmd.KeepAlive)).catch(() => undefined);
      }, 1000);
    } catch (err) {
      this.transport = null;
      this.device = null;
      this.status = 'disconnected';
      this.addLog('error', err instanceof Error ? err.message : String(err));
      this.publish();
      throw err;
    }
    this.status = 'connected';
    this.resetTimebase();
    this.live.clear();
    this.resetCounters();
    this.smoother.reset();
    this.addLog('connect', transport.info.name);
    this.publisher ??= setInterval(() => this.publish(), PUBLISH_MS);
    this.publish();
  }

  async disconnect(): Promise<void> {
    if (!this.transport) return;
    const t = this.transport;
    this.teardown();
    await t.close();
    this.addLog('disconnect');
    this.publish();
  }

  private handleClose(reason?: string): void {
    if (!this.transport) return;
    this.teardown();
    this.addLog('disconnect', reason);
    this.publish();
  }

  private teardown(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    if (this.publisher) clearInterval(this.publisher);
    this.publisher = null;
    if (this.recState !== 'idle') this.stopRecording();
    this.settleTrigger(false);
    this.transport = null;
    this.status = 'disconnected';
    this.device = null;
    this.alarms = { vHigh: false, vLow: false, iHigh: false, pHigh: false, tHigh: false };
  }

  // ---- Incoming frames ---------------------------------------------------

  handleFrame(frame: Uint8Array): void {
    this.frames++;
    if (frame[0] !== FRAME_HEAD || !frameCrcOk(frame)) {
      this.crcErrors++;
      return;
    }
    switch (frame[1]) {
      case Reply.Data: {
        const samples = decodeDataFrame(frame);
        if (samples) for (const s of samples) this.ingest(s.voltage, s.current, s.dp, s.dn, s.temp);
        this.rateWindow.push(this.clock());
        break;
      }
      case Reply.DeviceInfo:
        if (this.device) {
          const fw = frame[8] | (frame[9] << 8);
          this.device = {
            ...this.device,
            infoHex: toHex(frame.subarray(2, 18)),
            firmware: fw ? `${Math.floor(fw / 100)}.${String(fw % 100).padStart(2, '0')}` : '',
          };
        }
        break;
      case Reply.TriggerOk:
        this.settleTrigger(true);
        break;
      case Reply.TriggerFail:
        this.settleTrigger(false);
        break;
      default:
        this.lastOther = toHex(frame, 20);
    }
  }

  private resetTimebase(): void {
    this.origin = 0;
    this.sampleCount = 0;
    this.gapOffset = 0;
  }

  private ingest(v: number, i: number, dp: number, dn: number, temp: number): void {
    const wall = this.clock() / 1000;
    if (this.sampleCount === 0) this.origin = wall;
    let t = this.sampleCount * SAMPLE_PERIOD_S + this.gapOffset;
    // If the meter went quiet (cable glitch, suspended laptop), device time falls
    // behind the wall clock. Jump forward so durations and integrals stay honest.
    const behind = wall - this.origin - t;
    if (behind > GAP_TOLERANCE_S) {
      this.gapOffset += behind;
      t += behind;
      this.gaps++;
      this.addLog('gap', behind.toFixed(1));
    }
    this.sampleCount++;

    const last = this.live.length - 1;
    const dt = last >= 0 ? t - this.live.t[last] : 0;
    // Do not integrate across a gap: nothing is known about that interval.
    const usable = dt > 0 && dt < GAP_TOLERANCE_S ? dt : 0;
    this.live.push(t, v, i, dp, dn, temp);
    if (this.countersAt < 0) this.countersAt = t;
    this.as += i * usable;
    this.ws += v * i * usable;
    this.sV.add(v);
    this.sI.add(i);
    this.sP.add(v * i);
    this.sT.add(temp);

    this.recordSample(t, v, i, dp, dn, temp, usable);
  }

  // ---- Counters ----------------------------------------------------------

  resetCounters(): void {
    this.countersAt = this.live.length ? this.live.tEnd : -1;
    this.as = 0;
    this.ws = 0;
    this.sV.reset();
    this.sI.reset();
    this.sP.reset();
    this.sT.reset();
    this.publish();
  }

  // ---- Recorder ----------------------------------------------------------

  startRecording(config: RecordConfig = this.recordConfig): void {
    if (this.status !== 'connected' || this.recState !== 'idle') return;
    this.recordConfig = { ...config };
    this.recStore = new SampleStore({ capacity: 16384, maxCapacity: REC_MAX_SAMPLES });
    this.recAs = 0;
    this.recWs = 0;
    this.recBelowSince = -1;
    this.acc = { n: 0, t: 0, v: 0, i: 0, dp: 0, dn: 0, temp: 0 };
    this.recT0 = -1;
    this.recState = config.startCurrent > 0 ? 'armed' : 'recording';
    if (this.recState === 'recording') this.beginCapture();
    this.publish();
  }

  private beginCapture(): void {
    this.recStartedAt = Date.now();
    this.addLog('recStart');
  }

  pauseRecording(): void {
    if (this.recState === 'recording') this.recState = 'paused';
    else if (this.recState === 'paused') this.recState = 'recording';
    this.publish();
  }

  /** Ends the recording and hands it to onRecordingFinished when it holds data. */
  stopRecording(): FinishedRecording | null {
    if (this.recState === 'idle') return null;
    const store = this.recStore;
    this.recState = 'idle';
    this.recStore = null;
    let done: FinishedRecording | null = null;
    if (store && store.length > 1) {
      done = {
        store: store.snapshot(),
        rate: this.recordConfig.rate,
        startedAt: this.recStartedAt,
        device: this.device?.model ?? 'FNB58',
        ah: this.recAs / 3600,
        wh: this.recWs / 3600,
      };
      this.addLog('recStop', String(store.length));
      this.onRecordingFinished?.(done);
    }
    this.publish();
    return done;
  }

  private recordSample(t: number, v: number, i: number, dp: number, dn: number, temp: number, dt: number): void {
    const cfg = this.recordConfig;
    if (this.recState === 'armed') {
      if (i < cfg.startCurrent) return;
      this.recState = 'recording';
      this.beginCapture();
    }
    if (this.recState !== 'recording' || !this.recStore) return;
    if (this.recT0 < 0) this.recT0 = t;
    else {
      this.recAs += i * dt;
      this.recWs += v * i * dt;
    }

    const a = this.acc;
    // A reduced-rate point is the mean of its block, stamped at the block's start.
    if (a.n === 0) a.t = t - this.recT0;
    a.n++;
    a.v += v;
    a.i += i;
    a.dp += dp;
    a.dn += dn;
    a.temp += temp;
    const every = 100 / cfg.rate;
    if (a.n >= every) {
      const ok = this.recStore.push(a.t, a.v / a.n, a.i / a.n, a.dp / a.n, a.dn / a.n, a.temp / a.n);
      this.acc = { n: 0, t: 0, v: 0, i: 0, dp: 0, dn: 0, temp: 0 };
      if (!ok) {
        this.stopRecording();
        return;
      }
    }

    if (cfg.stopCurrent > 0) {
      if (i < cfg.stopCurrent) {
        if (this.recBelowSince < 0) this.recBelowSince = t;
        else if (t - this.recBelowSince >= cfg.stopDelay) this.stopRecording();
      } else {
        this.recBelowSince = -1;
      }
    }
  }

  // ---- Trigger -----------------------------------------------------------

  /** Asks the charger for a voltage. Resolves true when the meter confirms. */
  async trigger(p: TriggerProtocol, millivolts: number, timeoutMs = 3000): Promise<boolean> {
    if (!this.transport || this.status !== 'connected') return false;
    const frame = buildTriggerFrame(p, millivolts);
    this.settleTrigger(false);
    const result = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settleTrigger(false), timeoutMs);
      this.pendingTrigger = { resolve, timer };
    });
    await this.transport.send(frame);
    const ok = await result;
    this.addLog(ok ? 'trigger' : 'triggerFail', `${p.name} ${(millivolts / 1000).toFixed(2)} V`);
    this.publish();
    return ok;
  }

  private settleTrigger(ok: boolean): void {
    const p = this.pendingTrigger;
    if (!p) return;
    this.pendingTrigger = null;
    clearTimeout(p.timer);
    p.resolve(ok);
  }

  async release(): Promise<void> {
    if (!this.transport || this.status !== 'connected') return;
    await this.transport.send(buildReleaseFrame());
    this.addLog('release');
    this.publish();
  }

  // ---- Snapshot ----------------------------------------------------------

  private reading(): Reading | null {
    const n = this.live.length;
    if (!n || this.status !== 'connected') return null;
    const from = Math.max(0, n - READOUT_SAMPLES);
    const r = { v: 0, i: 0, p: 0, dp: 0, dn: 0, temp: 0 };
    for (let k = from; k < n; k++) {
      r.v += this.live.v[k];
      r.i += this.live.i[k];
      r.p += this.live.p[k];
      r.dp += this.live.dp[k];
      r.dn += this.live.dn[k];
      r.temp += this.live.temp[k];
    }
    const c = n - from;
    return { v: r.v / c, i: r.i / c, p: r.p / c, dp: r.dp / c, dn: r.dn / c, temp: r.temp / c };
  }

  private evalAlarms(now: Reading | null): void {
    const test = (key: AlarmKey, value: number, above: boolean): void => {
      const rule = this.alarmConfig[key];
      if (!rule.enabled || !now) {
        this.alarms[key] = false;
        return;
      }
      const band = Math.abs(rule.limit) * HYSTERESIS;
      const wasOn = this.alarms[key];
      const on = above
        ? value > (wasOn ? rule.limit - band : rule.limit)
        : value < (wasOn ? rule.limit + band : rule.limit);
      if (on && !wasOn) {
        this.addLog('alarm', key);
        this.onAlarm?.(key);
      }
      this.alarms[key] = on;
    };
    test('vHigh', now?.v ?? 0, true);
    // Low-voltage only matters while something is plugged in.
    test('vLow', now && now.v > 1 ? now.v : Infinity, false);
    test('iHigh', now?.i ?? 0, true);
    test('pHigh', now?.p ?? 0, true);
    test('tHigh', now?.temp ?? 0, true);
  }

  private buildSnapshot(): Snapshot {
    const now = this.reading();
    this.evalAlarms(now);
    if (now) this.guess = this.smoother.push(guessProtocol(now.v, now.dp, now.dn));
    else this.guess = 'none';

    const t = this.clock();
    while (this.rateWindow.length && t - this.rateWindow[0] > 2000) this.rateWindow.shift();
    const mm = (s: RunningStats): MinMax => ({ min: s.min, max: s.max, mean: s.mean });
    const rec = this.recStore;
    return {
      status: this.status,
      transport: this.transport?.info ?? null,
      device: this.device,
      now,
      elapsed: this.live.length && this.countersAt >= 0 ? this.live.tEnd - this.countersAt : 0,
      ah: this.as / 3600,
      wh: this.ws / 3600,
      stats: this.sV.count ? { v: mm(this.sV), i: mm(this.sI), p: mm(this.sP), temp: mm(this.sT) } : null,
      guess: this.guess,
      rec: {
        state: this.recState,
        samples: rec?.length ?? 0,
        duration: rec?.duration ?? 0,
        ah: this.recAs / 3600,
        wh: this.recWs / 3600,
        full: rec?.full ?? false,
      },
      alarms: { ...this.alarms },
      diag: {
        frames: this.frames,
        crcErrors: this.crcErrors,
        gaps: this.gaps,
        rate: (this.rateWindow.length / 2) * 4,
        lastOther: this.lastOther,
      },
      log: this.log,
    };
  }
}

export const engine = new Engine();
