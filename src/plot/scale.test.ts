import { describe, expect, it } from 'vitest';
import { autoRange, decimalsFor, niceStep, niceTimeStep, ticks } from './scale';

describe('scale', () => {
  it('picks round steps', () => {
    expect(niceStep(1, 4)).toBe(0.25);
    expect(niceStep(20, 4)).toBe(5);
    expect(niceStep(0.15, 3)).toBeCloseTo(0.05, 9);
    expect(niceStep(7, 3)).toBe(2.5);
  });

  it('lists ticks without float dust', () => {
    expect(ticks(0, 1, 0.25)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(ticks(8.95, 9.1, 0.05).map((x) => x.toFixed(2))).toEqual(['8.95', '9.00', '9.05', '9.10']);
    expect(ticks(-1, 1, 1)).toEqual([-1, 0, 1]);
  });

  it('knows how many decimals a step needs', () => {
    expect(decimalsFor(5)).toBe(0);
    expect(decimalsFor(0.5)).toBe(1);
    expect(decimalsFor(0.25)).toBe(2);
    expect(decimalsFor(0.002)).toBe(3);
  });

  it('picks human time steps', () => {
    expect(niceTimeStep(60, 5)).toBe(15);
    expect(niceTimeStep(10, 5)).toBe(2);
    expect(niceTimeStep(3600, 6)).toBe(600);
  });

  it('enforces a minimum span so noise does not fill the lane', () => {
    const r = autoRange(5.001, 5.003, null, { minSpan: 0.2, floorZero: true });
    expect(r.max - r.min).toBeGreaterThanOrEqual(0.2);
    expect(r.min).toBeLessThan(5.001);
    expect(r.max).toBeGreaterThan(5.003);
  });

  it('anchors near-zero loads at zero and never goes negative', () => {
    const r = autoRange(0.0, 2.02, null, { minSpan: 0.1, floorZero: true });
    expect(r.min).toBe(0);
    expect(r.max).toBeGreaterThan(2.02);
    expect(autoRange(0, 0, null, { minSpan: 0.1, floorZero: true }).min).toBe(0);
  });

  it('keeps the previous range while data still fits and fills it', () => {
    const o = { minSpan: 0.1, floorZero: true };
    const first = autoRange(1.0, 2.0, null, o);
    expect(autoRange(1.05, 1.95, first, o)).toBe(first);
    expect(autoRange(1.0, 4.0, first, o)).not.toBe(first); // outgrew it
    expect(autoRange(1.5, 1.52, first, o)).not.toBe(first); // shrank far below it
  });
});
