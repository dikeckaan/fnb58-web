// Stepped trigger plan: request a voltage, hold it, move on.

import { isValidTrigger, snapTrigger, TRIGGER_PROTOCOLS, type TriggerProtocol } from '../device/protocol';

export interface Step {
  id: string;
  protocol: TriggerProtocol['id'];
  millivolts: number;
  /** Hold time in milliseconds. */
  holdMs: number;
}

export const MAX_STEPS = 200;
export const MAX_HOLD_MS = 3_600_000;
/** Shortest hold the runner honours, so a plan cannot flood the meter with requests. */
export const MIN_HOLD_MS = 200;

/**
 * Builds a step from untrusted input, such as an imported file or stored
 * settings. Returns null unless the result is something the meter can be asked for.
 */
export function sanitizeStep(raw: unknown, id: string): Step | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const p = TRIGGER_PROTOCOLS.find((x) => x.id === r.protocol);
  if (!p || typeof r.millivolts !== 'number' || !Number.isFinite(r.millivolts)) return null;
  const millivolts = snapTrigger(p, Math.round(r.millivolts));
  if (!isValidTrigger(p, millivolts)) return null;
  const hold = Number(r.holdMs);
  const holdMs = Number.isFinite(hold) ? Math.min(MAX_HOLD_MS, Math.max(0, Math.round(hold))) : 0;
  return { id, protocol: p.id, millivolts, holdMs };
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
    steps = steps.slice(0, MAX_STEPS);
    try {
      do {
        for (let k = 0; k < steps.length && !this.stopped; k++) {
          // Steps are checked again here: they may come from stored settings.
          const s = sanitizeStep(steps[k], steps[k]?.id ?? '');
          if (!s || s.holdMs <= 0) continue;
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
          await this.sleep(Math.max(MIN_HOLD_MS, s.holdMs));
        }
      } while (loop && !this.stopped && steps.some((s) => (sanitizeStep(s, '')?.holdMs ?? 0) > 0));
      if (this.stopped && reason !== 'failed') reason = 'stopped';
      if (releaseAtEnd) await this.host.release();
    } finally {
      this.running = false;
      cb.onEnd(reason);
    }
  }
}
