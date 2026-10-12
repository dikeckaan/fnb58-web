// A software meter. It speaks the real wire format, so everything downstream of
// the transport (CRC check, decode, timing, counters) runs exactly as with hardware.

import {
  buildFrame, Cmd, encodeDataFrame, frameCrcOk, Reply, SAMPLES_PER_PACKET, SAMPLE_PERIOD_S,
  TRIGGER_PROTOCOLS, type RawSample,
} from './protocol';
import type { Transport, TransportEvents, TransportInfo } from './transport';

export type Scenario = 'phone' | 'laptop' | 'powerbank' | 'iot' | 'idle';
export const SCENARIOS: Scenario[] = ['phone', 'laptop', 'powerbank', 'iot', 'idle'];

/** Small deterministic PRNG so runs are repeatable in tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Source {
  v: number;
  dp: number;
  dn: number;
}

export class MeterModel {
  private n = 0;
  private readonly rand: () => number;
  private vNow = 5.08;
  private iNow = 0;
  private temp = 27.5;
  /** Voltage requested through a trigger command, or null when released. */
  private forced: Source | null = null;

  constructor(public scenario: Scenario, seed = 58) {
    this.rand = mulberry32(seed);
  }

  private noise(amp: number): number {
    return (this.rand() - 0.5) * 2 * amp;
  }

  trigger(protocolIndex: number, millivolts: number): boolean {
    const p = TRIGGER_PROTOCOLS.find((x) => x.index === protocolIndex);
    if (!p) return false;
    const v = millivolts / 1000;
    let dp = 0.6;
    let dn = 0;
    if (p.id === 'qc2') [dp, dn] = v >= 19 ? [3.3, 3.3] : v >= 11 ? [0.6, 0.6] : v >= 8 ? [3.3, 0.6] : [0.6, 0];
    else if (p.id === 'qc3') [dp, dn] = [0.6, 3.3];
    this.forced = { v, dp, dn };
    return true;
  }

  release(): void {
    this.forced = null;
  }

  /** What the charger wants to supply and what the load wants to draw at time t. */
  private target(t: number): { src: Source; amps: number } {
    if (this.forced) {
      // A triggered supply feeding a resistive-ish dummy load.
      return { src: this.forced, amps: Math.min(3, this.forced.v / 6) };
    }
    switch (this.scenario) {
      case 'idle':
        return { src: { v: 5.08, dp: 0.02, dn: 0.02 }, amps: 0 };
      case 'laptop': {
        if (t < 1.5) return { src: { v: 5.05, dp: 0, dn: 0 }, amps: 0.08 };
        const burst = Math.sin(t / 7) > 0.55 ? 0.9 : 0;
        const amps = 2.1 + burst + 0.25 * Math.sin(t / 2.3) + (Math.floor(t / 23) % 2 ? 0.35 : 0);
        return { src: { v: 20.1, dp: 0, dn: 0 }, amps };
      }
      case 'powerbank': {
        const sag = Math.min(0.45, t / 900);
        const pulse = Math.floor(t / 11) % 3 === 0 ? 0.4 : 0;
        return { src: { v: 5.12 - sag, dp: 2.7, dn: 2.7 }, amps: 1.05 + pulse };
      }
      case 'iot': {
        // A battery sensor node: asleep, then a short wake with a radio burst.
        const ph = t % 4;
        const amps = ph < 0.3 ? 0.038 : ph < 0.36 ? 0.16 : 0.00035;
        return { src: { v: 5.08, dp: 0.02, dn: 0.02 }, amps };
      }
      case 'phone':
      default: {
        if (t < 2.5) return { src: { v: 5.06, dp: 0.6, dn: 0.6 }, amps: 0.45 };
        if (t < 3.6) return { src: { v: 5.06, dp: 0.6, dn: 0 }, amps: 0.45 };
        const tc = t - 3.6;
        const cc = 2.02;
        const taperAt = 150;
        const amps = tc < taperAt ? cc : Math.max(0.06, cc * Math.exp(-(tc - taperAt) / 55));
        // The phone briefly pauses charging now and then, as real ones do.
        const pause = tc > 20 && (tc % 47) < 0.45 ? 0.2 : 1;
        return { src: { v: 9.04, dp: 3.3, dn: 0.6 }, amps: amps * pause };
      }
    }
  }

  next(): RawSample {
    const t = this.n * SAMPLE_PERIOD_S;
    this.n++;
    const { src, amps } = this.target(t);
    // First-order settling: supplies slew, loads ramp.
    this.vNow += (src.v - this.vNow) * 0.08;
    // A microcontroller wakes within a sample; chargers and big loads ramp.
    this.iNow += (amps - this.iNow) * (this.scenario === 'iot' && !this.forced ? 0.7 : 0.12);
    const cableDrop = this.iNow * 0.045;
    const ripple = 0.006 * Math.sin(t * 2 * Math.PI * 12.5) * (0.4 + this.iNow);
    const v = Math.max(0, this.vNow - cableDrop + ripple + this.noise(0.0015));
    const floor = this.scenario === 'iot' && !this.forced ? 0.00003 : 0.002;
    const i = Math.max(0, this.iNow + this.noise(floor + this.iNow * 0.002));
    const heat = 27.5 + Math.min(22, v * i * 0.9);
    this.temp += (heat - this.temp) * 0.0006;
    return {
      voltage: v,
      current: i,
      dp: Math.max(0, src.dp + this.noise(0.003)),
      dn: Math.max(0, src.dn + this.noise(0.003)),
      temp: this.temp,
    };
  }

  nextFrame(): Uint8Array {
    const samples: RawSample[] = [];
    for (let k = 0; k < SAMPLES_PER_PACKET; k++) samples.push(this.next());
    return encodeDataFrame(samples);
  }
}

const PACKET_MS = SAMPLES_PER_PACKET * SAMPLE_PERIOD_S * 1000;

export class SimTransport implements Transport {
  readonly info: TransportInfo;
  readonly model: MeterModel;
  private events: TransportEvents | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private streaming = false;
  private startedAt = 0;
  private sent = 0;

  constructor(scenario: Scenario = 'phone') {
    this.model = new MeterModel(scenario);
    this.info = { kind: 'sim', name: 'FNB58' };
  }

  async open(events: TransportEvents): Promise<void> {
    this.events = events;
  }

  async send(frame: Uint8Array): Promise<void> {
    if (!frameCrcOk(frame)) return; // A real meter ignores corrupt frames too.
    switch (frame[1]) {
      case Cmd.Hello:
        // Same payload a real FNB58 returned during development.
        this.emit(buildFrame(Reply.DeviceInfo, [0x02, 0, 0, 0, 0x3a, 0, 0x73, 0, 0x6a, 0xcd, 0, 0, 0x83, 0]));
        break;
      case Cmd.Start:
        this.begin();
        break;
      case Cmd.Trigger: {
        const ok = this.model.trigger(frame[2], frame[3] | (frame[4] << 8));
        setTimeout(() => this.emit(buildFrame(ok ? Reply.TriggerOk : Reply.TriggerFail)), 120);
        break;
      }
      case Cmd.Release:
        this.model.release();
        break;
    }
  }

  private emit(frame: Uint8Array): void {
    this.events?.onFrame(frame);
  }

  private begin(): void {
    if (this.streaming) return;
    this.streaming = true;
    this.startedAt = performance.now();
    this.sent = 0;
    // Background tabs throttle timers, so each tick sends however many packets are due.
    this.timer = setInterval(() => this.pump(), PACKET_MS);
  }

  private pump(): void {
    const due = Math.floor((performance.now() - this.startedAt) / PACKET_MS);
    let burst = Math.min(due - this.sent, 500);
    if (due - this.sent > 500) {
      // Slept too long to replay; skip ahead like a meter whose packets were dropped.
      this.sent = due - 500;
    }
    while (burst-- > 0) {
      this.emit(this.model.nextFrame());
      this.sent++;
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.streaming = false;
    this.events = null;
  }
}
