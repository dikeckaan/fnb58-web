// Bench helpers that live outside the page: a floating always-on-top readout,
// a tone that follows a channel, and spoken level changes.

import { create } from 'zustand';
import { engine, type Reading } from '../core/engine';
import { useSettings } from './settings';

export type ToneChannel = 'i' | 'v' | 'p';

interface Gadgets {
  listen: boolean;
  channel: ToneChannel;
  voice: boolean;
  floating: Window | null;
}

export const useGadgets = create<Gadgets>(() => ({ listen: false, channel: 'i', voice: false, floating: null }));

// ---- Tone ------------------------------------------------------------------

/** Span each channel maps onto the tone's four octaves. Current is logarithmic. */
const TONE_RANGE: Record<ToneChannel, { lo: number; hi: number; log: boolean }> = {
  i: { lo: 0.001, hi: 5, log: true },
  v: { lo: 3, hi: 21, log: false },
  p: { lo: 0.01, hi: 100, log: true },
};
const TONE_BASE = 110;
const TONE_OCTAVES = 4;

/** Pitch in Hz for a reading. Exported for tests. */
export function toneFrequency(channel: ToneChannel, value: number): number {
  const r = TONE_RANGE[channel];
  const x = Math.min(r.hi, Math.max(r.lo, value));
  const norm = r.log ? Math.log(x / r.lo) / Math.log(r.hi / r.lo) : (x - r.lo) / (r.hi - r.lo);
  return TONE_BASE * 2 ** (norm * TONE_OCTAVES);
}

let ctx: AudioContext | null = null;
let osc: OscillatorNode | null = null;
let gain: GainNode | null = null;

function startTone(): void {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  if (osc) return;
  osc = ctx.createOscillator();
  gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = TONE_BASE;
  gain.gain.value = 0;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
}

function stopTone(): void {
  if (!ctx || !osc || !gain) return;
  const o = osc;
  gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
  o.stop(ctx.currentTime + 0.2);
  osc = null;
  gain = null;
}

function updateTone(now: Reading | null): void {
  if (!ctx || !osc || !gain) return;
  const { channel } = useGadgets.getState();
  const t = ctx.currentTime;
  // Silent with nothing to read, so an unplugged meter does not drone.
  gain.gain.setTargetAtTime(now ? 0.07 : 0, t, 0.05);
  if (now) osc.frequency.setTargetAtTime(toneFrequency(channel, now[channel]), t, 0.04);
}

// ---- Voice -----------------------------------------------------------------

const SETTLE_TICKS = 6; // about 0.75 s of unchanged readings
let spokenV = NaN;
let candidate = NaN;
let steady = 0;

/** Text spoken for a settled level. Exported for tests. */
export function spokenText(lang: 'tr' | 'en', v: number, i: number): string {
  const volts = v.toFixed(1);
  const amps = i.toFixed(2);
  if (lang === 'tr') return `${volts.replace('.', ',')} volt, ${amps.replace('.', ',')} amper`;
  return `${volts} volts, ${amps} amps`;
}

function updateVoice(now: Reading | null): void {
  if (!now || typeof speechSynthesis === 'undefined') return;
  if (Math.abs(now.v - candidate) > 0.08) {
    candidate = now.v;
    steady = 0;
    return;
  }
  if (++steady < SETTLE_TICKS) return;
  if (!Number.isNaN(spokenV) && Math.abs(now.v - spokenV) < 0.4) return;
  spokenV = now.v;
  const { lang } = useSettings.getState();
  const u = new SpeechSynthesisUtterance(spokenText(lang, now.v, now.i));
  u.lang = lang === 'tr' ? 'tr-TR' : 'en-GB';
  u.rate = 1.1;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

export const voiceSupported = (): boolean => typeof speechSynthesis !== 'undefined';

let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  engine.subscribe(() => {
    const g = useGadgets.getState();
    if (!g.listen && !g.voice) return;
    const { now } = engine.getSnapshot();
    if (g.listen) updateTone(now);
    if (g.voice) updateVoice(now);
  });
}

/** Must be called from a click, as browsers only start audio on a user gesture. */
export function setListen(on: boolean): void {
  wire();
  try {
    if (on) startTone();
    else stopTone();
    useGadgets.setState({ listen: on });
  } catch {
    useGadgets.setState({ listen: false });
  }
}

export function setVoice(on: boolean): void {
  wire();
  spokenV = NaN;
  candidate = NaN;
  steady = 0;
  if (!on && voiceSupported()) speechSynthesis.cancel();
  useGadgets.setState({ voice: on });
}

// ---- Floating readout ------------------------------------------------------

interface DocumentPictureInPicture {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}

const pipApi = (): DocumentPictureInPicture | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;

export const floatingSupported = (): boolean => !!pipApi();

/** Opens a small window that stays above other applications. Needs a click. */
export async function openFloating(): Promise<void> {
  const api = pipApi();
  if (!api) return;
  const existing = useGadgets.getState().floating;
  if (existing && !existing.closed) return existing.focus();
  const w = await api.requestWindow({ width: 330, height: 250 });
  // The new document starts bare; bring the page's styles and fonts along.
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.href) {
      const link = w.document.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      w.document.head.append(link);
      continue;
    }
    try {
      const style = w.document.createElement('style');
      style.textContent = Array.from(sheet.cssRules, (r) => r.cssText).join('\n');
      w.document.head.append(style);
    } catch {
      // A cross-origin sheet cannot be read; the readout still works without it.
    }
  }
  w.document.documentElement.lang = document.documentElement.lang;
  w.document.title = 'FNB58';
  w.document.body.className = 'float-body';
  w.addEventListener('pagehide', () => useGadgets.setState({ floating: null }));
  useGadgets.setState({ floating: w });
}

export function closeFloating(): void {
  useGadgets.getState().floating?.close();
  useGadgets.setState({ floating: null });
}
