import { describe, expect, it } from 'vitest';
import { spokenText, toneFrequency } from './gadgets';

describe('toneFrequency', () => {
  it('spans four octaves and clamps outside the range', () => {
    expect(toneFrequency('i', 0.001)).toBeCloseTo(110, 6);
    expect(toneFrequency('i', 5)).toBeCloseTo(1760, 6);
    expect(toneFrequency('i', 0)).toBeCloseTo(110, 6);
    expect(toneFrequency('i', 50)).toBeCloseTo(1760, 6);
  });

  it('gives each decade of current the same musical interval', () => {
    const a = toneFrequency('i', 0.01) / toneFrequency('i', 0.001);
    const b = toneFrequency('i', 1) / toneFrequency('i', 0.1);
    expect(a).toBeCloseTo(b, 9);
    expect(a).toBeGreaterThan(1.5);
  });

  it('maps voltage linearly', () => {
    expect(toneFrequency('v', 12)).toBeCloseTo(110 * 2 ** 2, 6);
  });
});

describe('spokenText', () => {
  it('uses a decimal comma in Turkish', () => {
    expect(spokenText('tr', 9.04, 2.018)).toBe('9,0 volt, 2,02 amper');
    expect(spokenText('en', 9.04, 2.018)).toBe('9.0 volts, 2.02 amps');
  });
});
