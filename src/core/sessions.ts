// Recordings library in IndexedDB. Metadata and sample columns live in separate
// object stores so listing never loads megabytes of samples.

import { SampleStore } from './sampleStore';

export interface SessionMeta {
  id: string;
  name: string;
  /** Wall-clock milliseconds when the recording began. */
  createdAt: number;
  device: string;
  rate: number;
  samples: number;
  duration: number;
  ah: number;
  wh: number;
  vMean: number;
  iMax: number;
  pMax: number;
  note: string;
  source: 'recorded' | 'imported';
}

interface SessionData {
  id: string;
  t: ArrayBuffer;
  v: ArrayBuffer;
  i: ArrayBuffer;
  dp: ArrayBuffer;
  dn: ArrayBuffer;
  temp: ArrayBuffer;
}

const DB_NAME = 'fnb58-bench';
const META = 'meta';
const DATA = 'data';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META, { keyPath: 'id' });
      req.result.createObjectStore(DATA, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function ask<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function describeStore(
  store: SampleStore,
  base: Pick<SessionMeta, 'name' | 'createdAt' | 'device' | 'rate' | 'ah' | 'wh' | 'source'>,
): SessionMeta {
  let vSum = 0;
  let iMax = 0;
  let pMax = 0;
  for (let k = 0; k < store.length; k++) {
    vSum += store.v[k];
    if (store.i[k] > iMax) iMax = store.i[k];
    if (store.p[k] > pMax) pMax = store.p[k];
  }
  return {
    id: newId(),
    ...base,
    samples: store.length,
    duration: store.duration,
    vMean: store.length ? vSum / store.length : 0,
    iMax,
    pMax,
    note: '',
  };
}

export async function saveSession(meta: SessionMeta, store: SampleStore): Promise<void> {
  const n = store.length;
  const data: SessionData = {
    id: meta.id,
    t: store.t.slice(0, n).buffer as ArrayBuffer,
    v: store.v.slice(0, n).buffer as ArrayBuffer,
    i: store.i.slice(0, n).buffer as ArrayBuffer,
    dp: store.dp.slice(0, n).buffer as ArrayBuffer,
    dn: store.dn.slice(0, n).buffer as ArrayBuffer,
    temp: store.temp.slice(0, n).buffer as ArrayBuffer,
  };
  const db = await openDb();
  const tx = db.transaction([META, DATA], 'readwrite');
  tx.objectStore(META).put(meta);
  tx.objectStore(DATA).put(data);
  await done(tx);
}

export async function listSessions(): Promise<SessionMeta[]> {
  const db = await openDb();
  const all = await ask<SessionMeta[]>(db.transaction(META).objectStore(META).getAll());
  // Records written by an older build may hold a name or note that is not text.
  const text = (x: unknown, fallback: string) => (typeof x === 'string' ? x : fallback);
  return all
    .map((m) => ({ ...m, name: text(m.name, String(m.id)), note: text(m.note, '') }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadSession(id: string): Promise<SampleStore | null> {
  const db = await openDb();
  const d = await ask<SessionData | undefined>(db.transaction(DATA).objectStore(DATA).get(id));
  if (!d) return null;
  const t = new Float64Array(d.t);
  const n = t.length;
  const store = new SampleStore({ capacity: Math.max(16, n), maxCapacity: Math.max(16, n) });
  store.t.set(t);
  store.v.set(new Float32Array(d.v));
  store.i.set(new Float32Array(d.i));
  store.dp.set(new Float32Array(d.dp));
  store.dn.set(new Float32Array(d.dn));
  store.temp.set(new Float32Array(d.temp));
  for (let k = 0; k < n; k++) store.p[k] = store.v[k] * store.i[k];
  store.length = n;
  return store;
}

export async function updateSession(id: string, patch: Partial<Pick<SessionMeta, 'name' | 'note'>>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(META, 'readwrite');
  const os = tx.objectStore(META);
  const cur = await ask<SessionMeta | undefined>(os.get(id));
  if (cur) os.put({ ...cur, ...patch });
  await done(tx);
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, DATA], 'readwrite');
  tx.objectStore(META).delete(id);
  tx.objectStore(DATA).delete(id);
  await done(tx);
}
