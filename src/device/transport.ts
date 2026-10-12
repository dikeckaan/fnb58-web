export interface TransportInfo {
  kind: 'webhid' | 'sim';
  name: string;
  vendorId?: number;
  productId?: number;
}

export interface TransportEvents {
  /** One 64-byte frame, starting with 0xAA. */
  onFrame(frame: Uint8Array): void;
  onClose(reason?: string): void;
}

export interface Transport {
  readonly info: TransportInfo;
  open(events: TransportEvents): Promise<void>;
  send(frame: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
