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
    if (!Number.isFinite(t) || !Number.isFinite(v) || !Number.isFinite(i)) continue;
    if (Number.isNaN(t0)) t0 = t;
    const rel = t - t0;
    if (rel <= prev) continue; // keep time strictly increasing
    prev = rel;
    store.push(rel, v, i, num(dpi) || 0, num(dni) || 0, num(tempi) || 0);
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
