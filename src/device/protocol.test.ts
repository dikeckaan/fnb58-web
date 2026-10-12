import { describe, expect, it } from 'vitest';
import {
  buildFrame, buildReleaseFrame, buildTriggerFrame, Cmd, crc8, decodeDataFrame, encodeDataFrame,
  frameCrcOk, snapTrigger, TRIGGER_PROTOCOLS,
} from './protocol';

describe('frames', () => {
  // Checksums below are the literal bytes the community logger sends to real meters.
  it.each([
    [Cmd.Hello, 0x8e],
    [Cmd.Start, 0x96],
    [Cmd.KeepAlive, 0x9e],
  ])('command 0x%s carries the known checksum', (cmd, crc) => {
    const f = buildFrame(cmd);
    expect(f.length).toBe(64);
    expect(f[0]).toBe(0xaa);
    expect(f[1]).toBe(cmd);
    expect(f[63]).toBe(crc);
    expect(frameCrcOk(f)).toBe(true);
  });

  it('matches the logger CRC convention (init 0x42 over bytes 1..62)', () => {
    expect(crc8(new Uint8Array([0xaa]))).toBe(0x42);
  });

  it('detects corruption', () => {
    const f = buildFrame(Cmd.Start);
    f[10] ^= 1;
    expect(frameCrcOk(f)).toBe(false);
  });
});

describe('data frame', () => {
  it('round-trips four samples', () => {
    const samples = [
      { voltage: 5.12345, current: 1.98765, dp: 0.612, dn: 0.598, temp: 31.4 },
      { voltage: 9.00001, current: 0, dp: 3.3, dn: 0.6, temp: 0 },
      { voltage: 20.1, current: 4.99999, dp: 0, dn: 0, temp: -4.5 },
      { voltage: 0, current: 0.00001, dp: 2.7, dn: 2.0, temp: 88.8 },
    ];
    const decoded = decodeDataFrame(encodeDataFrame(samples))!;
    expect(decoded).toHaveLength(4);
    decoded.forEach((d, i) => {
      expect(d.voltage).toBeCloseTo(samples[i].voltage, 5);
      expect(d.current).toBeCloseTo(samples[i].current, 5);
      expect(d.dp).toBeCloseTo(samples[i].dp, 3);
      expect(d.dn).toBeCloseTo(samples[i].dn, 3);
      expect(d.temp).toBeCloseTo(samples[i].temp, 1);
    });
  });

  it('reads the documented byte layout', () => {
    const f = new Uint8Array(64);
    f[0] = 0xaa; f[1] = 0x04;
    // sample 0: 5.00000 V = 500000 = 0x0007A120, 1.50000 A = 150000 = 0x000249F0
    f.set([0x20, 0xa1, 0x07, 0x00, 0xf0, 0x49, 0x02, 0x00, 0x58, 0x02, 0x58, 0x02, 0x01, 0x19, 0x01], 2);
    const s = decodeDataFrame(f)![0];
    expect(s.voltage).toBe(5);
    expect(s.current).toBe(1.5);
    expect(s.dp).toBe(0.6);
    expect(s.dn).toBe(0.6);
    expect(s.temp).toBe(28.1);
  });

  it('ignores non-data frames', () => {
    expect(decodeDataFrame(buildFrame(0x03))).toBeNull();
  });
});

describe('trigger', () => {
  const [qc2, qc3, fcp, scp, afc] = TRIGGER_PROTOCOLS;

  it('encodes protocol index and little-endian millivolts', () => {
    const f = buildTriggerFrame(qc2, 9000);
    expect([f[1], f[2], f[3], f[4]]).toEqual([0x88, 0, 0x28, 0x23]);
    expect(frameCrcOk(f)).toBe(true);
    const g = buildTriggerFrame(afc, 12000);
    expect([g[2], g[3], g[4]]).toEqual([4, 0xe0, 0x2e]);
  });

  it('refuses voltages the protocol does not offer', () => {
    expect(() => buildTriggerFrame(qc2, 15000)).toThrow(RangeError);
    expect(() => buildTriggerFrame(fcp, 20000)).toThrow(RangeError);
    expect(() => buildTriggerFrame(qc3, 3700)).toThrow(RangeError);
    expect(() => buildTriggerFrame(scp, 10020)).toThrow(RangeError);
    expect(() => buildTriggerFrame(afc, 5000)).toThrow(RangeError);
  });

  it('snaps to the nearest allowed value', () => {
    expect(snapTrigger(qc2, 10000)).toBe(9000);
    expect(snapTrigger(qc3, 3710)).toBe(3800);
    expect(snapTrigger(qc3, 99999)).toBe(20000);
    expect(snapTrigger(scp, 5011)).toBe(5020);
  });

  it('release is command 0x89 with no payload', () => {
    const f = buildReleaseFrame();
    expect(f[1]).toBe(0x89);
    expect(f.slice(2, 63).every((b) => b === 0)).toBe(true);
  });
});
