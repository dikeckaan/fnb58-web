// FNIRSI FNB-series USB tester wire protocol.
// Reading side follows the community logger; trigger commands were recovered
// from the vendor's Windows tool. See docs/superpowers/specs for provenance.

export const FRAME_SIZE = 64;
export const FRAME_HEAD = 0xaa;
export const SAMPLE_PERIOD_S = 0.01;
export const SAMPLES_PER_PACKET = 4;

export const Cmd = {
  Hello: 0x81,
  Start: 0x82,
  KeepAlive: 0x83,
  Trigger: 0x88,
  Release: 0x89,
} as const;

export const Reply = {
  DeviceInfo: 0x03,
  Data: 0x04,
  TriggerOk: 0x07,
  TriggerFail: 0x08,
} as const;

export interface DeviceModel {
  vendorId: number;
  productId: number;
  name: string;
  /** FNB58 and FNB48S repeat Start as the third init frame; older models send KeepAlive. */
  fastFamily: boolean;
}

export const MODELS: DeviceModel[] = [
  { vendorId: 0x2e3c, productId: 0x5558, name: 'FNB58', fastFamily: true },
  { vendorId: 0x2e3c, productId: 0x0049, name: 'FNB48S', fastFamily: true },
  { vendorId: 0x0483, productId: 0x003a, name: 'FNB48', fastFamily: false },
  { vendorId: 0x0483, productId: 0x003b, name: 'C1', fastFamily: false },
  { vendorId: 0x0483, productId: 0x0038, name: 'FNB38', fastFamily: false },
  { vendorId: 0x0483, productId: 0x0039, name: 'FNB-C2', fastFamily: false },
];

export function findModel(vendorId: number, productId: number): DeviceModel | undefined {
  return MODELS.find((m) => m.vendorId === vendorId && m.productId === productId);
}

/** CRC-8, polynomial 0x39, init 0, no reflection. */
export function crc8(bytes: Uint8Array, length = bytes.length): number {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x39) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

export function buildFrame(cmd: number, payload?: ArrayLike<number>): Uint8Array {
  const frame = new Uint8Array(FRAME_SIZE);
  frame[0] = FRAME_HEAD;
  frame[1] = cmd & 0xff;
  if (payload) {
    const n = Math.min(payload.length, FRAME_SIZE - 3);
    for (let i = 0; i < n; i++) frame[2 + i] = payload[i] & 0xff;
  }
  frame[FRAME_SIZE - 1] = crc8(frame, FRAME_SIZE - 1);
  return frame;
}

export function frameCrcOk(frame: Uint8Array): boolean {
  return frame.length === FRAME_SIZE && crc8(frame, FRAME_SIZE - 1) === frame[FRAME_SIZE - 1];
}

export interface RawSample {
  voltage: number; // V
  current: number; // A
  dp: number; // V
  dn: number; // V
  temp: number; // °C
}

const SAMPLE_BYTES = 15;

/** Decode a type-0x04 frame into its four samples. Returns null for any other frame. */
export function decodeDataFrame(frame: Uint8Array): RawSample[] | null {
  if (frame.length < FRAME_SIZE || frame[0] !== FRAME_HEAD || frame[1] !== Reply.Data) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const out: RawSample[] = [];
  for (let i = 0; i < SAMPLES_PER_PACKET; i++) {
    const o = 2 + i * SAMPLE_BYTES;
    const tempMag = view.getUint16(o + 13, true) / 10;
    out.push({
      voltage: view.getUint32(o, true) / 100000,
      current: view.getUint32(o + 4, true) / 100000,
      dp: view.getUint16(o + 8, true) / 1000,
      dn: view.getUint16(o + 10, true) / 1000,
      temp: view.getUint8(o + 12) === 0 ? -tempMag : tempMag,
    });
  }
  return out;
}

export function encodeDataFrame(samples: RawSample[]): Uint8Array {
  const frame = new Uint8Array(FRAME_SIZE);
  const view = new DataView(frame.buffer);
  frame[0] = FRAME_HEAD;
  frame[1] = Reply.Data;
  for (let i = 0; i < SAMPLES_PER_PACKET; i++) {
    const s = samples[i] ?? samples[samples.length - 1];
    const o = 2 + i * SAMPLE_BYTES;
    view.setUint32(o, Math.max(0, Math.round(s.voltage * 100000)), true);
    view.setUint32(o + 4, Math.max(0, Math.round(s.current * 100000)), true);
    view.setUint16(o + 8, Math.max(0, Math.round(s.dp * 1000)), true);
    view.setUint16(o + 10, Math.max(0, Math.round(s.dn * 1000)), true);
    view.setUint8(o + 12, s.temp < 0 ? 0 : 1);
    view.setUint16(o + 13, Math.round(Math.abs(s.temp) * 10), true);
  }
  frame[FRAME_SIZE - 1] = crc8(frame, FRAME_SIZE - 1);
  return frame;
}

// ---- Fast-charge trigger -------------------------------------------------

export interface TriggerProtocol {
  index: number;
  id: 'qc2' | 'qc3' | 'fcp' | 'scp' | 'afc';
  name: string;
  /** Discrete choices in millivolts, or a stepped range. */
  fixed?: number[];
  range?: { min: number; max: number; step: number };
}

export const TRIGGER_PROTOCOLS: TriggerProtocol[] = [
  { index: 0, id: 'qc2', name: 'QC 2.0', fixed: [5000, 9000, 12000, 20000] },
  { index: 1, id: 'qc3', name: 'QC 3.0', range: { min: 3600, max: 20000, step: 200 } },
  { index: 2, id: 'fcp', name: 'Huawei FCP', fixed: [5000, 9000, 12000] },
  { index: 3, id: 'scp', name: 'Huawei SCP', range: { min: 3300, max: 10000, step: 20 } },
  { index: 4, id: 'afc', name: 'Samsung AFC', fixed: [9000, 12000] },
];

export function isValidTrigger(p: TriggerProtocol, millivolts: number): boolean {
  if (p.fixed) return p.fixed.includes(millivolts);
  if (p.range) {
    const { min, max, step } = p.range;
    return millivolts >= min && millivolts <= max && (millivolts - min) % step === 0;
  }
  return false;
}

/** Snap an arbitrary request to the nearest value the protocol allows. */
export function snapTrigger(p: TriggerProtocol, millivolts: number): number {
  if (p.fixed) {
    return p.fixed.reduce((best, v) => (Math.abs(v - millivolts) < Math.abs(best - millivolts) ? v : best));
  }
  const { min, max, step } = p.range!;
  const clamped = Math.min(max, Math.max(min, millivolts));
  return min + Math.round((clamped - min) / step) * step;
}

export function buildTriggerFrame(p: TriggerProtocol, millivolts: number): Uint8Array {
  if (!isValidTrigger(p, millivolts)) {
    throw new RangeError(`${p.name} cannot request ${millivolts} mV`);
  }
  return buildFrame(Cmd.Trigger, [p.index, millivolts & 0xff, (millivolts >> 8) & 0xff]);
}

export function buildReleaseFrame(): Uint8Array {
  return buildFrame(Cmd.Release);
}

export function toHex(bytes: Uint8Array, max = bytes.length): string {
  let s = '';
  for (let i = 0; i < Math.min(max, bytes.length); i++) s += bytes[i].toString(16).padStart(2, '0') + ' ';
  return s.trimEnd();
}
