import { useEffect, useRef, useState } from 'react';
import { decimalsFor, niceStep, ticks } from '../plot/scale';
import { SCOPE_THEME } from '../theme';

interface Props {
  kind: 'line' | 'bars' | 'scatter';
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  color: string;
  height?: number;
  /** Axis titles, drawn small in the corners. */
  xTitle: string;
  yTitle: string;
  /** Lines of text for the tooltip at data index k (line and bars). */
  tip?(k: number): string[];
  /** Tooltip for free coordinates (scatter). */
  tipAt?(x: number, y: number): string[];
  /** Straight line y = slope*x + intercept drawn over a scatter. */
  fit?: { slope: number; intercept: number } | null;
  /** Width of one bar in x units. */
  barWidth?: number;
  yFloorZero?: boolean;
  ariaLabel: string;
}

const M = { l: 58, r: 12, t: 22, b: 30 };

export function MiniChart({ kind, x, y, color, height = 220, xTitle, yTitle, tip, tipAt, fit, barWidth, yFloorZero, ariaLabel }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const geom = useRef({ x0: 0, x1: 1, y0: 0, y1: 1, w: 0, h: 0 });
  const [hover, setHover] = useState<{ px: number; py: number; lines: string[]; k: number } | null>(null);
  const [size, setSize] = useState(0);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize(el.clientWidth));
    ro.observe(el);
    // A font arriving late changes label widths; nudge a redraw.
    const onFont = () => setSize((w) => w + 0.001);
    document.fonts?.addEventListener('loadingdone', onFont);
    return () => {
      ro.disconnect();
      document.fonts?.removeEventListener('loadingdone', onFont);
    };
  }, []);

  useEffect(() => {
    const c = canvas.current;
    const el = wrap.current;
    if (!c || !el) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = height;
    if (w <= 0) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const n = Math.min(x.length, y.length);
    if (!n) return;

    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < n; k++) {
      if (!Number.isFinite(y[k]) || !Number.isFinite(x[k])) continue;
      if (x[k] < x0) x0 = x[k];
      if (x[k] > x1) x1 = x[k];
      if (y[k] < y0) y0 = y[k];
      if (y[k] > y1) y1 = y[k];
    }
    if (kind === 'bars' && barWidth) x1 += barWidth;
    if (!(x1 > x0)) {
      x0 -= 0.5;
      x1 += 0.5;
    }
    if (yFloorZero) y0 = Math.min(0, y0);
    if (!(y1 > y0)) {
      y0 -= 0.5;
      y1 += 0.5;
    }
    const pad = (y1 - y0) * 0.06;
    y1 += pad;
    if (!yFloorZero) y0 -= pad;
    if (kind === 'scatter') {
      const px = (x1 - x0) * 0.04;
      x0 -= px;
      x1 += px;
    }
    const pw = w - M.l - M.r;
    const ph = h - M.t - M.b;
    geom.current = { x0, x1, y0, y1, w: pw, h: ph };
    const X = (v: number) => M.l + ((v - x0) / (x1 - x0)) * pw;
    const Y = (v: number) => M.t + ph - ((v - y0) / (y1 - y0)) * ph;

    const yStep = niceStep(y1 - y0, Math.max(2, Math.floor(ph / 36)));
    const xStep = niceStep(x1 - x0, Math.max(2, Math.floor(pw / 90)));
    const yT = ticks(y0, y1, yStep);
    const xT = ticks(x0, x1, xStep);
    ctx.strokeStyle = SCOPE_THEME.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const v of yT) {
      const py = Math.round(Y(v)) + 0.5;
      ctx.moveTo(M.l, py);
      ctx.lineTo(M.l + pw, py);
    }
    ctx.stroke();

    ctx.font = SCOPE_THEME.font;
    ctx.fillStyle = SCOPE_THEME.axisText;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yd = decimalsFor(yStep);
    for (const v of yT) ctx.fillText(v.toFixed(yd), M.l - 6, Y(v));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xd = decimalsFor(xStep);
    for (const v of xT) ctx.fillText(v.toFixed(xd), X(v), M.t + ph + 5);
    ctx.textAlign = 'right';
    ctx.fillText(xTitle, M.l + pw, M.t + ph + 17);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(yTitle, 2, 0);

    ctx.save();
    ctx.beginPath();
    ctx.rect(M.l, M.t, pw, ph);
    ctx.clip();
    if (kind === 'line') {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k < n; k++) {
        if (!Number.isFinite(y[k])) continue;
        if (pen) ctx.lineTo(X(x[k]), Y(y[k]));
        else ctx.moveTo(X(x[k]), Y(y[k]));
        pen = true;
      }
      ctx.stroke();
    } else if (kind === 'bars') {
      const bw = barWidth ? (barWidth / (x1 - x0)) * pw : pw / n;
      const gap = bw > 5 ? 2 : 0;
      const r = Math.min(4, Math.max(0, (bw - gap) / 2));
      ctx.fillStyle = color;
      const base = Y(Math.max(y0, 0));
      for (let k = 0; k < n; k++) {
        if (!(y[k] > 0)) continue;
        const left = X(x[k]) + gap / 2;
        const top = Y(y[k]);
        ctx.beginPath();
        ctx.roundRect(left, top, Math.max(1, bw - gap), Math.max(1, base - top), [r, r, 0, 0]);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = color;
      ctx.globalAlpha = n > 2000 ? 0.35 : 0.6;
      const stride = Math.max(1, Math.floor(n / 6000));
      for (let k = 0; k < n; k += stride) ctx.fillRect(X(x[k]) - 1.25, Y(y[k]) - 1.25, 2.5, 2.5);
      ctx.globalAlpha = 1;
      if (fit) {
        ctx.strokeStyle = SCOPE_THEME.hover;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(X(x0), Y(fit.intercept + fit.slope * x0));
        ctx.lineTo(X(x1), Y(fit.intercept + fit.slope * x1));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (hover) {
      ctx.strokeStyle = SCOPE_THEME.hover;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(Math.round(hover.px) + 0.5, M.t);
      ctx.lineTo(Math.round(hover.px) + 0.5, M.t + ph);
      ctx.stroke();
      ctx.setLineDash([]);
      if (kind === 'line' && hover.k >= 0) {
        ctx.beginPath();
        ctx.arc(X(x[hover.k]), Y(y[hover.k]), 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = SCOPE_THEME.surface;
        ctx.stroke();
      }
    }
    ctx.restore();
  }, [kind, x, y, color, height, xTitle, yTitle, fit, barWidth, yFloorZero, hover, size]);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const g = geom.current;
    const n = Math.min(x.length, y.length);
    if (px < M.l || px > M.l + g.w || !n) return setHover(null);
    const xv = g.x0 + ((px - M.l) / g.w) * (g.x1 - g.x0);
    if (kind === 'scatter') {
      const yv = g.y0 + ((M.t + g.h - py) / g.h) * (g.y1 - g.y0);
      return setHover({ px, py, lines: tipAt ? tipAt(xv, yv) : [], k: -1 });
    }
    // x is sorted for line and bar data.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (x[mid] <= xv) lo = mid;
      else hi = mid - 1;
    }
    let k = lo;
    if (kind === 'line' && k + 1 < n && Math.abs(x[k + 1] - xv) < Math.abs(x[k] - xv)) k++;
    const cx = kind === 'bars' ? px : M.l + ((x[k] - g.x0) / (g.x1 - g.x0)) * g.w;
    setHover({ px: cx, py, lines: tip ? tip(k) : [], k });
  };

  return (
    <div
      className="mini-chart"
      ref={wrap}
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <canvas ref={canvas} />
      {hover && hover.lines.length > 0 && (
        <div className={`tip${hover.px > size - 200 ? ' flip' : ''}`} style={{ left: hover.px, top: Math.max(4, hover.py - 10) }} role="tooltip">
          {hover.lines.map((l, k) => (k === 0 ? <div className="tip-row" key={k}><b>{l}</b></div> : <div className="tip-time" key={k}>{l}</div>))}
        </div>
      )}
    </div>
  );
}
