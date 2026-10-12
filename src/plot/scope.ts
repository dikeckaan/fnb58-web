// Canvas renderer for one trace lane and for the shared time axis.
// A lane shows one unit, so there is never a second y-scale.

import type { Channel, SampleStore } from '../core/sampleStore';
import { autoRange, decimalsFor, niceStep, niceTimeStep, ticks, type YRange } from './scale';

export interface LaneSeries {
  channel: Channel;
  color: string;
  /** Dashed strokes give a second cue besides colour when two series share a lane. */
  dash?: number[];
}

export interface LaneSpec {
  id: string;
  series: LaneSeries[];
  minSpan: number;
  floorZero: boolean;
}

export interface ScopeTheme {
  grid: string;
  axisText: string;
  cursor: string;
  hover: string;
  band: string;
  surface: string;
  font: string;
}

/** Shared horizontal state for a group of lanes. Times are store seconds. */
export interface ViewState {
  t0: number;
  t1: number;
  hoverT: number | null;
  cursorA: number | null;
  cursorB: number | null;
}

export const Y_GUTTER = 52;

export function timeToX(t: number, view: ViewState, plotW: number): number {
  return ((t - view.t0) / (view.t1 - view.t0)) * plotW;
}

export function xToTime(x: number, view: ViewState, plotW: number): number {
  return view.t0 + (x / plotW) * (view.t1 - view.t0);
}

/** Typical spacing between samples, used to spot holes in the data. */
function nominalDt(store: SampleStore): number {
  const n = Math.min(store.length - 1, 50);
  return n > 0 ? (store.t[n] - store.t[0]) / n : 0.01;
}

interface Extent {
  lo: number;
  hi: number;
}

function visibleExtent(store: SampleStore, ch: Channel, i0: number, i1: number, e: Extent): void {
  const a = store.channel(ch);
  // Stride keeps this cheap on very long windows; extremes are refined by the draw pass.
  const stride = Math.max(1, Math.floor((i1 - i0) / 20000));
  for (let k = i0; k < i1; k += stride) {
    const x = a[k];
    if (x < e.lo) e.lo = x;
    if (x > e.hi) e.hi = x;
  }
}

function strokeSeries(
  ctx: CanvasRenderingContext2D, store: SampleStore, ch: Channel, view: ViewState, timeShift: number,
  plotW: number, h: number, range: YRange,
): void {
  const n = store.length;
  if (n < 1) return;
  const a = store.channel(ch);
  const t = store.t;
  const i0 = Math.max(0, store.lowerBound(view.t0 - timeShift) - 1);
  const i1 = Math.min(n, store.lowerBound(view.t1 - timeShift) + 1);
  if (i1 <= i0) return;
  const kx = plotW / (view.t1 - view.t0);
  const ky = h / (range.max - range.min);
  const X = (tt: number) => (tt + timeShift - view.t0) * kx;
  const Y = (v: number) => h - (v - range.min) * ky;
  const gap = Math.max(0.5, nominalDt(store) * 4);

  ctx.beginPath();
  if (i1 - i0 <= plotW * 2) {
    let pen = false;
    for (let k = i0; k < i1; k++) {
      if (pen && t[k] - t[k - 1] > gap) pen = false;
      if (pen) ctx.lineTo(X(t[k]), Y(a[k]));
      else ctx.moveTo(X(t[k]), Y(a[k]));
      pen = true;
    }
    if (i1 - i0 === 1) ctx.lineTo(X(t[i0]) + 1, Y(a[i0]));
  } else {
    // More samples than pixels: draw each pixel column's first, min, max, last.
    let col = -1;
    let first = 0;
    let last = 0;
    let lo = 0;
    let hi = 0;
    let pen = false;
    let prevT = t[i0];
    const flush = () => {
      if (col < 0) return;
      const x = col + 0.5;
      if (pen) ctx.lineTo(x, Y(first));
      else ctx.moveTo(x, Y(first));
      ctx.lineTo(x, Y(lo));
      ctx.lineTo(x, Y(hi));
      ctx.lineTo(x, Y(last));
      pen = true;
    };
    for (let k = i0; k < i1; k++) {
      const c = Math.floor(X(t[k]));
      const broke = t[k] - prevT > gap;
      prevT = t[k];
      if (c !== col || broke) {
        flush();
        if (broke) pen = false;
        col = c;
        first = lo = hi = last = a[k];
      } else {
        const x = a[k];
        if (x < lo) lo = x;
        if (x > hi) hi = x;
        last = x;
      }
    }
    flush();
  }
  ctx.stroke();
}

export class LaneRenderer {
  private range: YRange | null = null;
  /** The y-range of the last draw, for tooltips and tests. */
  lastRange: YRange = { min: 0, max: 1 };

  constructor(readonly spec: LaneSpec) {}

  resetRange(): void {
    this.range = null;
  }

  /**
   * Draws into a context already scaled so that 1 unit is 1 CSS pixel.
   * `overlay` is a second recording aligned at its own start for comparison.
   */
  draw(
    ctx: CanvasRenderingContext2D, w: number, h: number, store: SampleStore, view: ViewState, theme: ScopeTheme,
    overlay?: SampleStore | null,
  ): void {
    const plotW = Math.max(10, w - Y_GUTTER);
    ctx.clearRect(0, 0, w, h);
    if (!(view.t1 > view.t0)) return;

    const e: Extent = { lo: Infinity, hi: -Infinity };
    const i0 = Math.max(0, store.lowerBound(view.t0) - 1);
    const i1 = Math.min(store.length, store.lowerBound(view.t1) + 1);
    for (const s of this.spec.series) visibleExtent(store, s.channel, i0, i1, e);
    const shift = overlay ? store.tStart - overlay.tStart : 0;
    if (overlay) {
      const o0 = Math.max(0, overlay.lowerBound(view.t0 - shift) - 1);
      const o1 = Math.min(overlay.length, overlay.lowerBound(view.t1 - shift) + 1);
      for (const s of this.spec.series) visibleExtent(overlay, s.channel, o0, o1, e);
    }
    const range = (this.range = autoRange(e.lo, e.hi, this.range, this.spec));
    this.lastRange = range;

    // Grid, kept quieter than the data.
    const yStep = niceStep(range.max - range.min, Math.max(2, Math.floor(h / 34)));
    const yTicks = ticks(range.min, range.max, yStep);
    const tStep = niceTimeStep(view.t1 - view.t0, Math.max(2, Math.floor(plotW / 110)));
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    for (const y of yTicks) {
      const py = Math.round(h - ((y - range.min) / (range.max - range.min)) * h) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(plotW, py);
    }
    for (const t of ticks(view.t0, view.t1, tStep)) {
      const px = Math.round(timeToX(t, view, plotW)) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
    }
    ctx.stroke();

    // Region between the two measurement cursors.
    if (view.cursorA !== null && view.cursorB !== null) {
      const xa = timeToX(Math.min(view.cursorA, view.cursorB), view, plotW);
      const xb = timeToX(Math.max(view.cursorA, view.cursorB), view, plotW);
      ctx.fillStyle = theme.band;
      ctx.fillRect(Math.max(0, xa), 0, Math.min(plotW, xb) - Math.max(0, xa), h);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, h);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (overlay) {
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 4]);
      for (const s of this.spec.series) {
        ctx.strokeStyle = s.color;
        strokeSeries(ctx, overlay, s.channel, view, shift, plotW, h, range);
      }
      ctx.globalAlpha = 1;
    }
    ctx.lineWidth = 2;
    for (const s of this.spec.series) {
      ctx.strokeStyle = s.color;
      ctx.setLineDash(s.dash ?? []);
      strokeSeries(ctx, store, s.channel, view, 0, plotW, h, range);
    }
    ctx.setLineDash([]);

    const vline = (t: number | null, color: string, dash: number[]) => {
      if (t === null || t < view.t0 || t > view.t1) return;
      const px = Math.round(timeToX(t, view, plotW)) + 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    vline(view.cursorA, theme.cursor, []);
    vline(view.cursorB, theme.cursor, []);
    vline(view.hoverT, theme.hover, [3, 4]);

    // Mark the hovered sample on each series; the ring separates it from the trace.
    if (view.hoverT !== null && store.length) {
      const k = store.nearest(view.hoverT);
      const px = timeToX(store.t[k], view, plotW);
      for (const s of this.spec.series) {
        const py = h - ((store.channel(s.channel)[k] - range.min) / (range.max - range.min)) * h;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = theme.surface;
        ctx.stroke();
      }
    }
    ctx.restore();

    // Y labels sit in their own gutter so they never cover the trace.
    const d = decimalsFor(yStep);
    ctx.font = theme.font;
    ctx.fillStyle = theme.axisText;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const y of yTicks) {
      const py = h - ((y - range.min) / (range.max - range.min)) * h;
      if (py < 7 || py > h - 7) continue;
      ctx.fillText(y.toFixed(d), w - 4, py);
    }
  }
}

export interface TimeAxisOptions {
  /** Live views label ticks relative to the newest sample. */
  relativeTo: number | null;
  /** Suffix for seconds and minutes, already translated. */
  units: { s: string; min: string; h: string; now: string };
}

export function formatClock(seconds: number, withFraction = false): string {
  const neg = seconds < 0;
  const s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = withFraction ? sec.toFixed(2).padStart(5, '0') : String(Math.floor(sec)).padStart(2, '0');
  return `${neg ? '−' : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${ss}`;
}

function relativeLabel(dt: number, step: number, u: TimeAxisOptions['units']): string {
  if (Math.abs(dt) < step * 1e-6) return u.now;
  const a = Math.abs(dt);
  if (step >= 3600) return `−${+(a / 3600).toFixed(1)} ${u.h}`;
  if (step >= 60) return `−${+(a / 60).toFixed(1)} ${u.min}`;
  return `−${+a.toFixed(decimalsFor(step))} ${u.s}`;
}

export function drawTimeAxis(
  ctx: CanvasRenderingContext2D, w: number, h: number, view: ViewState, theme: ScopeTheme, o: TimeAxisOptions,
): void {
  const plotW = Math.max(10, w - Y_GUTTER);
  ctx.clearRect(0, 0, w, h);
  if (!(view.t1 > view.t0)) return;
  const step = niceTimeStep(view.t1 - view.t0, Math.max(2, Math.floor(plotW / 110)));
  ctx.font = theme.font;
  ctx.fillStyle = theme.axisText;
  ctx.textBaseline = 'middle';
  // Relative axes count back from the right edge, so ticks are anchored there.
  const anchor = o.relativeTo;
  const list = anchor !== null
    ? ticks(view.t0 - anchor, view.t1 - anchor, step).map((d) => d + anchor)
    : ticks(view.t0, view.t1, step);
  for (const t of list) {
    const px = timeToX(t, view, plotW);
    const label = anchor !== null
      ? relativeLabel(t - anchor, step, o.units)
      : formatClock(t, step < 1);
    const half = ctx.measureText(label).width / 2;
    ctx.textAlign = px - half < 0 ? 'left' : px + half > plotW ? 'right' : 'center';
    ctx.fillText(label, Math.min(plotW, Math.max(0, px)), h / 2);
  }
}
