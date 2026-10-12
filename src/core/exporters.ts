import { SampleStore } from './sampleStore';

export const CSV_HEADER = 'time_s,voltage_V,current_A,power_W,dplus_V,dminus_V,temp_C';

/** CSV as string chunks, so a long recording never becomes one giant string. */
export function csvParts(store: SampleStore, rowsPerChunk = 20000): string[] {
  const parts: string[] = [CSV_HEADER + '\n'];
  for (let from = 0; from < store.length; from += rowsPerChunk) {
    const to = Math.min(store.length, from + rowsPerChunk);
    let s = '';
    for (let k = from; k < to; k++) {
      s += `${store.t[k].toFixed(3)},${store.v[k].toFixed(5)},${store.i[k].toFixed(5)},${store.p[k].toFixed(5)},`
        + `${store.dp[k].toFixed(3)},${store.dn[k].toFixed(3)},${store.temp[k].toFixed(1)}\n`;
    }
    parts.push(s);
  }
  return parts;
}

export function toCsv(store: SampleStore): string {
  return csvParts(store).join('');
}

/** One day at 100 samples/s, the same ceiling a recording has. */
export const MAX_IMPORT_ROWS = 8_640_000;
export const MAX_IMPORT_BYTES = 600 * 1024 * 1024;
const sane = (x: number) => Number.isFinite(x) && Math.abs(x) < 1e6;

/** A display name from untrusted input: always a short string. */
export function cleanName(x: unknown, fallback: string): string {
  const s = typeof x === 'string' ? x.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120) : '';
  return s || fallback;
}

/** Rebuilds CSV text from the column arrays of this app's JSON export. Throws 'columns' on any other shape. */
export function columnsToCsv(columns: unknown): string {
  const c = (columns ?? {}) as Record<string, unknown>;
  const col = (k: string, required: boolean): unknown[] | null => {
    if (Array.isArray(c[k])) return c[k] as unknown[];
    if (required) throw new Error('columns');
    return null;
  };
  const t = col('t', true)!;
  const v = col('v', true)!;
  const i = col('i', true)!;
  if (t.length > MAX_IMPORT_ROWS) throw new Error('size');
  const dp = col('dp', false);
  const dn = col('dn', false);
  const temp = col('temp', false);
  const n = (x: unknown) => (typeof x === 'number' ? x : NaN);
  const rows = t.map((tt, k) => `${n(tt)},${n(v[k])},${n(i[k])},${n(dp?.[k]) || 0},${n(dn?.[k]) || 0},${n(temp?.[k]) || 0}`);
  return ['time_s,voltage_V,current_A,dplus_V,dminus_V,temp_C', ...rows].join('\n');
}

const ALIASES: Record<string, 't' | 'v' | 'i' | 'dp' | 'dn' | 'temp'> = {
  time_s: 't', time: 't', t: 't', timestamp: 't',
  voltage_v: 'v', voltage: 'v', v: 'v', vbus: 'v',
  current_a: 'i', current: 'i', i: 'i', a: 'i', ibus: 'i',
  dplus_v: 'dp', 'd+': 'dp', dp: 'dp', dplus: 'dp',
  dminus_v: 'dn', 'd-': 'dn', dn: 'dn', dminus: 'dn',
  temp_c: 'temp', temp: 'temp', temperature: 'temp', temp_c_ema: 'temp',
};

/**
 * Reads CSV written by this app, and anything similar that has at least time,
 * voltage and current columns. Throws with a plain message when it cannot.
 */
export function parseCsv(text: string): SampleStore {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('empty');
  if (lines.length - 1 > MAX_IMPORT_ROWS) throw new Error('size');
  const sep = lines[0].includes(';') && !lines[0].includes(',') ? ';' : lines[0].includes('\t') ? '\t' : ',';
  const cols = lines[0].split(sep).map((c) => ALIASES[c.trim().toLowerCase()]);
  const idx = (k: string) => cols.indexOf(k as never);
  const [ti, vi, ii, dpi, dni, tempi] = [idx('t'), idx('v'), idx('i'), idx('dp'), idx('dn'), idx('temp')];
  if (ti < 0 || vi < 0 || ii < 0) throw new Error('columns');

  const store = new SampleStore({ capacity: lines.length, maxCapacity: Math.max(lines.length, 16) });
  let t0 = NaN;
  let prev = -Infinity;
  for (let r = 1; r < lines.length; r++) {
    const f = lines[r].split(sep);
    const num = (k: number) => (k >= 0 ? Number(sep === ';' ? f[k]?.replace(',', '.') : f[k]) : 0);
    const t = num(ti);
    const v = num(vi);
    const i = num(ii);
    // Values are stored as 32-bit floats; anything that would overflow there is not a measurement.
    if (!Number.isFinite(t) || !sane(v) || !sane(i)) continue;
    if (Number.isNaN(t0)) t0 = t;
    const rel = t - t0;
    if (rel <= prev) continue; // keep time strictly increasing
    prev = rel;
    const opt = (k: number) => {
      const x = num(k);
      return sane(x) ? x : 0;
    };
    store.push(rel, v, i, opt(dpi), opt(dni), opt(tempi));
  }
  if (store.length < 2) throw new Error('rows');
  return store;
}

export function downloadBlob(parts: BlobPart[], filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function safeFilename(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_').slice(0, 80) || 'fnb58';
}
