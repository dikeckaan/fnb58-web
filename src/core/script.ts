// Runs short user-written test scripts against the meter. A script is the body
// of an async function; everything it may touch is passed in by name.

export interface ScriptReading {
  t: number;
  v: number;
  i: number;
  p: number;
  dp: number;
  dn: number;
  temp: number;
}

export interface ScriptMean extends ScriptReading {
  /** Peak-to-peak voltage and current over the averaging window. */
  vpp: number;
  ipp: number;
  samples: number;
}

/** What the host must provide. The runner adds timing, logging and verdicts. */
export interface ScriptHost {
  read(): ScriptReading | null;
  mean(seconds: number): ScriptMean | null;
  trigger(protocol: string, volts: number): Promise<boolean>;
  release(): Promise<void>;
  startRecording(): void;
  stopRecording(): void;
  resetCounters(): void;
  counters(): { ah: number; wh: number; elapsed: number };
}

export type Cell = string | number | boolean | null;

export interface ScriptEvent {
  kind: 'log' | 'pass' | 'fail' | 'error' | 'row';
  text: string;
  cells?: Cell[];
}

export interface ScriptResult {
  /** 'pass' when every check held, 'fail' when one did not, 'none' without checks. */
  verdict: 'pass' | 'fail' | 'none' | 'error' | 'stopped';
  checks: number;
  failed: number;
  error?: string;
}

export class ScriptStopped extends Error {
  constructor() {
    super('stopped');
    this.name = 'ScriptStopped';
  }
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

function show(x: unknown): string {
  if (typeof x === 'number') return Number.isInteger(x) ? String(x) : x.toPrecision(6).replace(/\.?0+$/, '');
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x, (_, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(6)) : v));
  } catch {
    return String(x);
  }
}

export const SCRIPT_NAMES = [
  'read', 'mean', 'sleep', 'waitFor', 'trigger', 'release', 'record', 'reset', 'counters',
  'log', 'row', 'check', 'near',
] as const;

/**
 * Runs a script to completion or until the signal aborts. Every await point in
 * the provided API checks the signal, so stopping takes effect at the next call.
 */
export async function runScript(
  code: string,
  host: ScriptHost,
  emit: (e: ScriptEvent) => void,
  signal: AbortSignal,
  now: () => number = () => performance.now(),
): Promise<ScriptResult> {
  let checks = 0;
  let failed = 0;
  /** A voltage requested by this script is still being held. */
  let holding = false;
  const guard = () => {
    if (signal.aborted) throw new ScriptStopped();
  };
  const sleep = (seconds: number) =>
    new Promise<void>((resolve, reject) => {
      guard();
      const done = () => {
        signal.removeEventListener('abort', stop);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, Number(seconds) || 0) * 1000);
      const stop = () => {
        clearTimeout(timer);
        reject(new ScriptStopped());
      };
      signal.addEventListener('abort', stop, { once: true });
    });
  const need = <T,>(x: T | null): T => {
    if (x === null) throw new Error('no data: connect the meter or start the simulator first');
    return x;
  };
  const check = (ok: unknown, label = '') => {
    guard();
    checks++;
    if (!ok) failed++;
    emit({ kind: ok ? 'pass' : 'fail', text: String(label) });
    return Boolean(ok);
  };

  const api: Record<(typeof SCRIPT_NAMES)[number], unknown> = {
    read: () => {
      guard();
      return need(host.read());
    },
    mean: async (seconds = 1) => {
      // Wait for the window to fill with data taken after the call.
      await sleep(seconds);
      return need(host.mean(seconds));
    },
    sleep,
    waitFor: async (test: (r: ScriptReading) => unknown, timeout = 10) => {
      const until = now() + timeout * 1000;
      for (;;) {
        guard();
        const r = host.read();
        if (r && test(r)) return true;
        if (now() >= until) return false;
        await sleep(0.05);
      }
    },
    trigger: async (protocol: string, volts: number) => {
      guard();
      const ok = await host.trigger(String(protocol), Number(volts));
      if (ok) holding = true;
      return ok;
    },
    release: async () => {
      guard();
      await host.release();
      holding = false;
    },
    record: {
      start: () => {
        guard();
        host.startRecording();
      },
      stop: () => host.stopRecording(),
    },
    reset: () => {
      guard();
      host.resetCounters();
    },
    counters: () => host.counters(),
    log: (...parts: unknown[]) => {
      guard();
      emit({ kind: 'log', text: parts.map(show).join(' ') });
    },
    row: (...cells: Cell[]) => {
      guard();
      emit({ kind: 'row', text: cells.map(show).join('\t'), cells });
    },
    check,
    near: (value: number, target: number, tolerance: number, label = '') =>
      check(Math.abs(value - target) <= tolerance, `${label ? `${label}: ` : ''}${show(value)} ≈ ${show(target)} ± ${show(tolerance)}`),
  };

  // A script that stops or fails must not leave the charger at a raised voltage.
  const letGo = async () => {
    if (!holding) return;
    holding = false;
    await host.release().catch(() => undefined);
  };
  try {
    const fn = new AsyncFunction(...SCRIPT_NAMES, `"use strict";\n${code}`);
    await fn(...SCRIPT_NAMES.map((k) => api[k]));
  } catch (e) {
    await letGo();
    if (e instanceof ScriptStopped || signal.aborted) return { verdict: 'stopped', checks, failed };
    const error = e instanceof Error ? e.message : String(e);
    emit({ kind: 'error', text: error });
    return { verdict: 'error', checks, failed, error };
  }
  return { verdict: !checks ? 'none' : failed ? 'fail' : 'pass', checks, failed };
}
