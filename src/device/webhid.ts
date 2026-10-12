import { FRAME_HEAD, FRAME_SIZE, findModel, MODELS } from './protocol';
import type { Transport, TransportEvents, TransportInfo } from './transport';

export function webHidSupported(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

const FILTERS: HIDDeviceFilter[] = MODELS.map((m) => ({ vendorId: m.vendorId, productId: m.productId }));

export function isSupportedDevice(d: HIDDevice): boolean {
  return !!findModel(d.vendorId, d.productId);
}

/** Opens the browser's device chooser. Must run inside a user gesture. */
export async function requestMeter(): Promise<HIDDevice | null> {
  const picked = await navigator.hid.requestDevice({ filters: FILTERS });
  return picked.find(isSupportedDevice) ?? null;
}

/** Meters this origin was already allowed to use, so reconnecting needs no chooser. */
export async function knownMeters(): Promise<HIDDevice[]> {
  return (await navigator.hid.getDevices()).filter(isSupportedDevice);
}

export class WebHidTransport implements Transport {
  readonly info: TransportInfo;
  private events: TransportEvents | null = null;
  /** Some HID stacks expose the leading 0xAA as a report ID instead of a data byte. */
  private outReportId = 0;

  constructor(private readonly device: HIDDevice) {
    this.info = {
      kind: 'webhid',
      name: findModel(device.vendorId, device.productId)?.name ?? device.productName,
      vendorId: device.vendorId,
      productId: device.productId,
    };
  }

  async open(events: TransportEvents): Promise<void> {
    this.events = events;
    if (!this.device.opened) await this.device.open();
    const ids = this.device.collections.flatMap((c) => (c.outputReports ?? []).map((r) => r.reportId ?? 0));
    this.outReportId = ids.includes(FRAME_HEAD) ? FRAME_HEAD : 0;
    this.device.addEventListener('inputreport', this.onReport);
    navigator.hid.addEventListener('disconnect', this.onDisconnect);
  }

  private onReport = (e: HIDInputReportEvent): void => {
    const body = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    let frame: Uint8Array;
    if (e.reportId === FRAME_HEAD && body.length >= FRAME_SIZE - 1) {
      frame = new Uint8Array(FRAME_SIZE);
      frame[0] = FRAME_HEAD;
      frame.set(body.subarray(0, FRAME_SIZE - 1), 1);
    } else if (body.length >= FRAME_SIZE) {
      frame = body.slice(0, FRAME_SIZE);
    } else {
      return;
    }
    this.events?.onFrame(frame);
  };

  private onDisconnect = (e: HIDConnectionEvent): void => {
    if (e.device === this.device) {
      this.detach();
      this.events?.onClose('unplugged');
    }
  };

  async send(frame: Uint8Array): Promise<void> {
    if (this.outReportId === FRAME_HEAD) await this.device.sendReport(FRAME_HEAD, frame.subarray(1) as BufferSource);
    else await this.device.sendReport(0, frame as BufferSource);
  }

  private detach(): void {
    this.device.removeEventListener('inputreport', this.onReport);
    navigator.hid.removeEventListener('disconnect', this.onDisconnect);
  }

  async close(): Promise<void> {
    this.detach();
    try {
      if (this.device.opened) await this.device.close();
    } catch {
      // Already gone; nothing left to release.
    }
  }
}
