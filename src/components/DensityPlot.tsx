import { useEffect, useRef, useState } from 'react';
import type { Density } from '../core/lab';
import { decimalsFor, niceStep, ticks } from '../plot/scale';
import { SCOPE_THEME } from '../theme';

interface Props {
  data: Density;
  /** Samples in the map, for the dwell share in the tooltip. */
  total: number;
  height?: number;
  ariaLabel: string;
  dwellLabel: string;
}

const M = { l: 58, r: 12, t: 22, b: 30 };
// One hue, dark to light, so a brighter cell always means more time spent there.
const LOW = [34, 56, 74];
const HIGH = [172, 214, 255];

/** Operating points on the V-I plane, shaded by dwell time, with constant-power curves. */
export function DensityPlot({ data, total, height = 260, ariaLabel, dwellLabel }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(0);
  const [hover, setHover] = useState<{ px: number; py: number; lines: string[] } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize(el.clientWidth);
      setHover(null);
    });
    ro.observe(el);
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
    const { nx, ny, counts, max, i0, i1, v0, v1 } = data;
    const pw = w - M.l - M.r;
    const ph = h - M.t - M.b;
    const X = (i: number) => M.l + ((i - i0) / (i1 - i0)) * pw;
    const Y = (v: number) => M.t + ph - ((v - v0) / (v1 - v0)) * ph;

    const iStep = niceStep(i1 - i0, Math.max(2, Math.floor(pw / 90)));
    const vStep = niceStep(v1 - v0, Math.max(2, Math.floor(ph / 36)));
    const iT = ticks(i0, i1, iStep);
    const vT = ticks(v0, v1, vStep);
    ctx.strokeStyle = SCOPE_THEME.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const v of vT) {
      const py = Math.round(Y(v)) + 0.5;
      ctx.moveTo(M.l, py);
      ctx.lineTo(M.l + pw, py);
    }
    ctx.stroke();

    // Logarithmic shading: a point visited once must stay visible next to one visited for minutes.
    const cw = pw / nx;
    const chh = ph / ny;
    const scale = Math.log(1 + max);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const n = counts[y * nx + x];
        if (!n) continue;
        const f = 0.25 + 0.75 * (Math.log(1 + n) / scale);
        const rgb = LOW.map((lo, k) => Math.round(lo + (HIGH[k] - lo) * f));
        ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
        ctx.fillRect(M.l + x * cw, M.t + ph - (y + 1) * chh, Math.ceil(cw), Math.ceil(chh));
      }
    }

    // Constant-power hyperbolas across the visible window.
    const pLo = Math.max(v0 * i0, 0);
    const pHi = v1 * i1;
    const pStep = niceStep(pHi - pLo, 4);
    ctx.save();
    ctx.beginPath();
    ctx.rect(M.l, M.t, pw, ph);
    ctx.clip();
    ctx.strokeStyle = SCOPE_THEME.axisText;
    ctx.fillStyle = SCOPE_THEME.axisText;
    ctx.font = SCOPE_THEME.font;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.textBaseline = 'top';
    for (const p of ticks(pLo, pHi, pStep)) {
      if (!(p > 0)) continue;
      // Only the stretch of the hyperbola that crosses the window.
      const ia = Math.max(i0, p / v1);
      const ib = Math.min(i1, v0 > 0 ? p / v0 : i1);
      if (!(ib > ia)) continue;
      ctx.beginPath();
      for (let s = 0; s <= 40; s++) {
        const i = ia + ((ib - ia) * s) / 40;
        if (s) ctx.lineTo(X(i), Y(p / i));
        else ctx.moveTo(X(i), Y(p / i));
      }
      ctx.stroke();
      const lx = X(ia);
      const ly = Y(p / ia);
      const right = lx > M.l + pw - 64;
      ctx.textAlign = right ? 'right' : 'left';
      ctx.fillText(`${p.toFixed(decimalsFor(pStep))} W`, lx + (right ? -5 : 5), Math.max(M.t + 3, ly + 3));
    }
    ctx.restore();
    ctx.setLineDash([]);

    ctx.font = SCOPE_THEME.font;
    ctx.fillStyle = SCOPE_THEME.axisText;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const vd = decimalsFor(vStep);
    for (const v of vT) ctx.fillText(v.toFixed(vd), M.l - 6, Y(v));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const id = decimalsFor(iStep);
    for (const i of iT) ctx.fillText(i.toFixed(id), X(i), M.t + ph + 5);
    ctx.textAlign = 'right';
    ctx.fillText('A', M.l + pw, M.t + ph + 17);
    ctx.textAlign = 'left';
    ctx.fillText('V', 2, 0);
  }, [data, height, size]);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const pw = rect.width - M.l - M.r;
    const ph = height - M.t - M.b;
    if (px < M.l || px > M.l + pw || py < M.t || py > M.t + ph) return setHover(null);
    const { nx, ny, counts, i0, i1, v0, v1 } = data;
    const i = i0 + ((px - M.l) / pw) * (i1 - i0);
    const v = v0 + ((M.t + ph - py) / ph) * (v1 - v0);
    const cx = Math.min(nx - 1, Math.floor(((px - M.l) / pw) * nx));
    const cy = Math.min(ny - 1, Math.floor(((M.t + ph - py) / ph) * ny));
    const share = total > 0 ? (counts[cy * nx + cx] / total) * 100 : 0;
    setHover({ px, py, lines: [`${v.toFixed(3)} V`, `${i.toFixed(3)} A`, `${(v * i).toFixed(2)} W`, `${dwellLabel} ${share.toFixed(2)} %`] });
  };

  return (
    <div className="mini-chart" ref={wrap} style={{ height }} role="img" aria-label={ariaLabel} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <canvas ref={canvas} />
      {hover && (
        <div className={`tip${hover.px > size - 200 ? ' flip' : ''}`} style={{ left: hover.px, top: Math.max(4, hover.py - 10) }} role="tooltip">
          {hover.lines.map((l, k) => (k === 0 ? <div className="tip-row" key={k}><b>{l}</b></div> : <div className="tip-time" key={k}>{l}</div>))}
        </div>
      )}
    </div>
  );
}
