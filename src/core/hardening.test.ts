import { describe, expect, it } from 'vitest';
import { cleanName, columnsToCsv, parseCsv } from './exporters';
import { MAX_HOLD_MS, MAX_STEPS, sanitizeStep, SequenceRunner, type Step } from './sequence';

describe('imported recordings', () => {
  it('turns any name into short plain text', () => {
    expect(cleanName({ evil: true }, 'file')).toBe('file');
    expect(cleanName(42, 'file')).toBe('file');
    expect(cleanName('  ok\u0000name ', 'file')).toBe('ok name');
    expect(cleanName('x'.repeat(500), 'file')).toHaveLength(120);
  });

  it('rejects column data of the wrong shape', () => {
    expect(() => columnsToCsv(undefined)).toThrow('columns');
    expect(() => columnsToCsv({ t: 'abc', v: [], i: [] })).toThrow('columns');
    expect(() => columnsToCsv({ t: [0, 1], v: [5, 5] })).toThrow('columns');
  });

  it('reads well-formed columns and drops non-numeric cells', () => {
    const s = parseCsv(columnsToCsv({ t: [0, 1, 2], v: [5, 'x', 5.2], i: [1, 1, 1.1], dp: [0.6, { a: 1 }, 0.6] }));
    expect(s.length).toBe(2);
    expect(s.dp[0]).toBeCloseTo(0.6, 5);
  });

  it('drops rows that would overflow the store', () => {
    const s = parseCsv('time_s,voltage_V,current_A,temp_C\n0,5,1,25\n1,1e300,1,25\n2,5,Infinity,25\n3,5,1,1e300\n4,5,1,25\n');
    expect(s.length).toBe(3);
    expect(Array.from(s.v.subarray(0, 3)).every(Number.isFinite)).toBe(true);
    expect(s.temp[1]).toBe(0);
  });
});

describe('trigger plan steps', () => {
  it('accepts a valid step and snaps the voltage', () => {
    expect(sanitizeStep({ protocol: 'qc3', millivolts: 9090, holdMs: 1500 }, 'a')).toEqual({ id: 'a', protocol: 'qc3', millivolts: 9000, holdMs: 1500 });
  });

  it('rejects what the meter cannot be asked for', () => {
    expect(sanitizeStep({ protocol: 'qc2', millivolts: NaN, holdMs: 100 }, 'a')).toBeNull();
    expect(sanitizeStep({ protocol: 'qc2', millivolts: Infinity, holdMs: 100 }, 'a')).toBeNull();
    expect(sanitizeStep({ protocol: 'nope', millivolts: 5000, holdMs: 100 }, 'a')).toBeNull();
    expect(sanitizeStep({ protocol: 'qc2', millivolts: '9000', holdMs: 100 }, 'a')).toBeNull();
    expect(sanitizeStep(null, 'a')).toBeNull();
  });

  it('bounds the hold time', () => {
    expect(sanitizeStep({ protocol: 'qc2', millivolts: 9000, holdMs: 1e30 }, 'a')!.holdMs).toBe(MAX_HOLD_MS);
    expect(sanitizeStep({ protocol: 'qc2', millivolts: 9000, holdMs: -5 }, 'a')!.holdMs).toBe(0);
    expect(sanitizeStep({ protocol: 'qc2', millivolts: 9000, holdMs: 'soon' }, 'a')!.holdMs).toBe(0);
    expect(sanitizeStep({ protocol: 'qc2', millivolts: 9000, holdMs: Infinity }, 'a')!.holdMs).toBe(0);
  });

  it('never sends an invalid stored step and caps the plan length', async () => {
    const sent: number[] = [];
    const host = {
      trigger: async (_p: unknown, mv: number) => {
        sent.push(mv);
        return true;
      },
      release: async () => undefined,
    };
    const runner = new SequenceRunner(host);
    const bad = { id: 'x', protocol: 'qc2', millivolts: NaN, holdMs: 1 } as Step;
    const good: Step = { id: 'y', protocol: 'qc2', millivolts: 9000, holdMs: 1 };
    const many = Array.from({ length: MAX_STEPS + 50 }, () => bad);
    const done = runner.run([bad, good, ...many], false, { onStep: () => undefined, onEnd: () => undefined });
    await done;
    expect(sent).toEqual([9000]);
  });
});
