// Stepped trigger plan: request a voltage, hold it, move on.

import { TRIGGER_PROTOCOLS, type TriggerProtocol } from '../device/protocol';

export interface Step {
  id: string;
  protocol: TriggerProtocol['id'];
  millivolts: number;
  /** Hold time in milliseconds. */
  holdMs: number;
}

export interface SequenceHost {
  trigger(p: TriggerProtocol, millivolts: number): Promise<boolean>;
  release(): Promise<void>;
}

export interface SequenceCallbacks {
  onStep(index: number, ok: boolean): void;
  onEnd(reason: 'finished' | 'stopped' | 'failed'): void;
}

export class SequenceRunner {
  private stopped = false;
  private wake: (() => void) | null = null;
  running = false;

  constructor(private readonly host: SequenceHost) {}

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done(): void {
        clearTimeout(timer);
        self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  async run(steps: Step[], loop: boolean, cb: SequenceCallbacks, releaseAtEnd = true): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    let reason: 'finished' | 'stopped' | 'failed' = 'finished';
    try {
      do {
        for (let k = 0; k < steps.length && !this.stopped; k++) {
          const s = steps[k];
          if (s.holdMs <= 0) continue;
          const p = TRIGGER_PROTOCOLS.find((x) => x.id === s.protocol)!;
          let ok = await this.host.trigger(p, s.millivolts);
          // The vendor tool retries once before giving up; chargers do miss a request.
          if (!ok && !this.stopped) ok = await this.host.trigger(p, s.millivolts);
          cb.onStep(k, ok);
          if (!ok) {
            reason = 'failed';
            this.stopped = true;
            break;
          }
          await this.sleep(s.holdMs);
        }
      } while (loop && !this.stopped && steps.some((s) => s.holdMs > 0));
      if (this.stopped && reason !== 'failed') reason = 'stopped';
      if (releaseAtEnd) await this.host.release();
    } finally {
      this.running = false;
      cb.onEnd(reason);
    }
  }
}
