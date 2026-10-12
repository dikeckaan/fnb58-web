import { formatClock } from './plot/scope';

export const DASH = '–';

export function num(x: number | null | undefined, digits: number): string {
  return x === null || x === undefined || !Number.isFinite(x) ? DASH : x.toFixed(digits);
}

export function clock(seconds: number, fraction = false): string {
  return formatClock(Math.max(0, seconds), fraction);
}

/** Charge with a unit that keeps three or four significant figures. */
export function charge(ah: number): { value: string; unit: string } {
  if (!Number.isFinite(ah)) return { value: DASH, unit: 'mAh' };
  const a = Math.abs(ah);
  if (a < 0.001) return { value: (ah * 1e6).toFixed(1), unit: 'µAh' };
  if (a < 10) return { value: (ah * 1000).toFixed(a < 0.1 ? 3 : 1), unit: 'mAh' };
  return { value: ah.toFixed(3), unit: 'Ah' };
}

export function energy(wh: number): { value: string; unit: string } {
  if (!Number.isFinite(wh)) return { value: DASH, unit: 'Wh' };
  const a = Math.abs(wh);
  if (a < 0.001) return { value: (wh * 1e6).toFixed(1), unit: 'µWh' };
  if (a < 1) return { value: (wh * 1000).toFixed(a < 0.1 ? 3 : 1), unit: 'mWh' };
  if (a < 1000) return { value: wh.toFixed(3), unit: 'Wh' };
  return { value: (wh / 1000).toFixed(3), unit: 'kWh' };
}

export function resistance(v: number, i: number): { value: string; unit: string } {
  if (!(i > 0.0005) || !Number.isFinite(v)) return { value: DASH, unit: 'Ω' };
  const r = v / i;
  if (r >= 1000) return { value: (r / 1000).toFixed(2), unit: 'kΩ' };
  return { value: r.toFixed(r < 10 ? 3 : 2), unit: 'Ω' };
}

export function dateTime(ms: number, lang: string): string {
  return new Date(ms).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-GB', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function timeOfDay(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
