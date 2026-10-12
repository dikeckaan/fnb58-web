// Columnar sample storage. Time is seconds from the store's origin.

export const CHANNELS = ['v', 'i', 'p', 'dp', 'dn', 'temp'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface Sample {
  t: number;
  v: number;
  i: number;
  dp: number;
  dn: number;
  temp: number;
}

export interface StoreOptions {
  /** Initial capacity in samples. */
  capacity?: number;
  /** Hard ceiling. A rolling store drops its oldest quarter here; a growing store refuses. */
  maxCapacity?: number;
  /** Rolling stores discard old data instead of refusing new data. */
  rolling?: boolean;
}

export class SampleStore {
  t: Float64Array;
  v: Float32Array;
  i: Float32Array;
  p: Float32Array;
  dp: Float32Array;
  dn: Float32Array;
  temp: Float32Array;
  length = 0;
  /** Bumps whenever contents change, so renderers can skip idle frames. */
  version = 0;
  private cap: number;
  private readonly maxCap: number;
  private readonly rolling: boolean;

  constructor(opts: StoreOptions = {}) {
    this.cap = Math.max(16, opts.capacity ?? 4096);
    this.maxCap = Math.max(this.cap, opts.maxCapacity ?? 8_640_000);
    this.rolling = opts.rolling ?? false;
    this.t = new Float64Array(this.cap);
    this.v = new Float32Array(this.cap);
    this.i = new Float32Array(this.cap);
    this.p = new Float32Array(this.cap);
    this.dp = new Float32Array(this.cap);
    this.dn = new Float32Array(this.cap);
    this.temp = new Float32Array(this.cap);
  }

  get capacity(): number {
    return this.cap;
  }

  get full(): boolean {
    return !this.rolling && this.length >= this.maxCap;
  }

  get tStart(): number {
    return this.length ? this.t[0] : 0;
  }

  get tEnd(): number {
    return this.length ? this.t[this.length - 1] : 0;
  }

  get duration(): number {
    return this.tEnd - this.tStart;
  }

  channel(c: Channel): Float32Array {
    return this[c];
  }

  /** Returns false when a non-rolling store is at its ceiling. */
  push(t: number, v: number, i: number, dp: number, dn: number, temp: number): boolean {
    if (this.length >= this.cap && !this.makeRoom()) return false;
    const n = this.length;
    this.t[n] = t;
    this.v[n] = v;
    this.i[n] = i;
    this.p[n] = v * i;
    this.dp[n] = dp;
    this.dn[n] = dn;
    this.temp[n] = temp;
    this.length = n + 1;
    this.version++;
    return true;
  }

  private makeRoom(): boolean {
    if (this.cap < this.maxCap) {
      this.resize(Math.min(this.maxCap, this.cap * 2));
      return true;
    }
    if (!this.rolling) return false;
    const drop = Math.floor(this.cap / 4);
    for (const a of this.arrays()) a.copyWithin(0, drop, this.length);
    this.length -= drop;
    return true;
  }

  private arrays(): (Float64Array | Float32Array)[] {
    return [this.t, this.v, this.i, this.p, this.dp, this.dn, this.temp];
  }

  private resize(cap: number): void {
    const grow = <T extends Float64Array | Float32Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(cap);
      b.set(a.subarray(0, this.length) as never);
      return b;
    };
    this.t = grow(this.t);
    this.v = grow(this.v);
    this.i = grow(this.i);
    this.p = grow(this.p);
    this.dp = grow(this.dp);
    this.dn = grow(this.dn);
    this.temp = grow(this.temp);
    this.cap = cap;
  }

  clear(): void {
    this.length = 0;
    this.version++;
  }

  /** First index whose time is >= t. */
  lowerBound(t: number): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.t[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Index of the sample closest in time to t, or -1 when empty. */
  nearest(t: number): number {
    if (!this.length) return -1;
    const hi = this.lowerBound(t);
    if (hi <= 0) return 0;
    if (hi >= this.length) return this.length - 1;
    return t - this.t[hi - 1] <= this.t[hi] - t ? hi - 1 : hi;
  }

  at(index: number): Sample {
    return {
      t: this.t[index], v: this.v[index], i: this.i[index],
      dp: this.dp[index], dn: this.dn[index], temp: this.temp[index],
    };
  }

  /** Compact copy holding exactly the current samples. */
  snapshot(): SampleStore {
    const s = new SampleStore({ capacity: Math.max(16, this.length), maxCapacity: Math.max(16, this.length) });
    s.t.set(this.t.subarray(0, this.length));
    for (const c of CHANNELS) s[c].set(this[c].subarray(0, this.length));
    s.length = this.length;
    return s;
  }
}
