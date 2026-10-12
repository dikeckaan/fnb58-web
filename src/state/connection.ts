// Glue between the browser's device APIs, user settings and the engine.

import { analyze } from '../core/analysis';
import { engine, type FinishedRecording } from '../core/engine';
import { describeStore, saveSession } from '../core/sessions';
import { SimTransport } from '../device/simulator';
import { isSupportedDevice, knownMeters, requestMeter, webHidSupported, WebHidTransport } from '../device/webhid';
import { beep } from './sound';
import { useSettings } from './settings';

type Listener = () => void;
const libraryListeners = new Set<Listener>();

/** Fires whenever the recordings library changes. */
export function onLibraryChange(fn: Listener): () => void {
  libraryListeners.add(fn);
  return () => libraryListeners.delete(fn);
}

export function libraryChanged(): void {
  for (const fn of libraryListeners) fn();
}

const savedListeners = new Set<Listener>();

/** Fires after a finished recording has been written to the library. */
export function onRecordingSaved(fn: Listener): () => void {
  savedListeners.add(fn);
  return () => savedListeners.delete(fn);
}

export let lastSavedId: string | null = null;

async function persistRecording(r: FinishedRecording): Promise<void> {
  const { lang } = useSettings.getState();
  const when = new Date(r.startedAt);
  const stamp = when.toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-GB', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const a = analyze(r.store);
  const meta = describeStore(r.store, {
    name: `${lang === 'tr' ? 'Kayıt' : 'Recording'} ${stamp}`,
    createdAt: r.startedAt,
    device: r.device,
    rate: r.rate,
    ah: a.ah,
    wh: a.wh,
    source: 'recorded',
  });
  await saveSession(meta, r.store);
  lastSavedId = meta.id;
  libraryChanged();
  for (const fn of savedListeners) fn();
}

export function wireEngine(): void {
  const s = useSettings.getState();
  engine.alarmConfig = structuredClone(s.alarms);
  engine.recordConfig = { ...s.record };
  engine.onAlarm = () => {
    if (useSettings.getState().sound) beep();
  };
  engine.onRecordingFinished = (r) => {
    void persistRecording(r);
  };
  useSettings.subscribe((next) => {
    engine.alarmConfig = structuredClone(next.alarms);
    if (engine.getSnapshot().rec.state === 'idle') engine.recordConfig = { ...next.record };
  });

  if (webHidSupported()) {
    navigator.hid.addEventListener('connect', (e) => {
      if (useSettings.getState().autoReconnect && !engine.connected && isSupportedDevice(e.device)) {
        void engine.connect(new WebHidTransport(e.device)).catch(() => undefined);
      }
    });
    if (s.autoReconnect) {
      void knownMeters().then((list) => {
        if (list[0] && !engine.connected) return engine.connect(new WebHidTransport(list[0]));
      }).catch(() => undefined);
    }
  }
}

/** Opens the browser chooser. Returns false when the user cancels. */
export async function connectMeter(): Promise<boolean> {
  const device = await requestMeter();
  if (!device) return false;
  await engine.connect(new WebHidTransport(device));
  return true;
}

export async function connectSimulator(): Promise<void> {
  await engine.connect(new SimTransport(useSettings.getState().scenario));
}
