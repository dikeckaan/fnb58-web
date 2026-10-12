import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Sample, SampleStore } from '../core/sampleStore';
import { channelStats, integrate } from '../core/stats';
import { charge, clock, energy, num } from '../format';
import { useT } from '../i18n';
import { drawTimeAxis, LaneRenderer, xToTime, Y_GUTTER, type ViewState } from '../plot/scope';
import { LANES, SCOPE_THEME, SERIES, type LaneId } from '../theme';

export interface ScopeHandle {
  clearCursors(): void;
  resume(): void;
  toPng(): string | null;
}

interface Props {
  store: SampleStore;
  /** Live scopes follow the newest sample; static ones show a finished recording. */
  live: boolean;
  lanes: LaneId[];
  overlay?: SampleStore | null;
  windowS?: number;
  onWindowChange?(seconds: number): void;
  /** Left-hand cell of each lane. `hover` is the sample under the pointer, if any. */
  readout(lane: LaneId, hover: Sample | null): ReactNode;
  toolbar?: ReactNode;
  handleRef?: React.RefObject<ScopeHandle | null>;
}

interface Tip {
  x: number;
  y: number;
  sample: Sample;
  flip: boolean;
}

interface Measure {
  dt: number;
  ah: number;
  wh: number;
  vMean: number;
  iMean: number;
  pMean: number;
}

const MIN_SPAN = 0.2;
const LIVE_MAX = 3600;

export function ScopeGroup({ store, live, lanes, overlay, windowS = 60, onWindowChange, readout, toolbar, handleRef }: Props) {
  const t = useT();
  const groupRef = useRef<HTMLDivElement>(null);
  const canvases = useRef(new Map<string, HTMLCanvasElement>());
  const renderers = useRef(new Map<LaneId, LaneRenderer>());
  const view = useRef<ViewState>({ t0: 0, t1: 1, hoverT: null, cursorA: null, cursorB: null });
  const follow = useRef(live);
  const windowRef = useRef(windowS);
  const dirty = useRef(true);
  const drag = useRef<{ x: number; t0: number; t1: number; moved: boolean } | null>(null);
  const nextCursor = useRef<'A' | 'B'>('A');
  const [following, setFollowing] = useState(live);
  const [tip, setTip] = useState<Tip | null>(null);
  const [measure, setMeasure] = useState<Measure | null>(null);

  windowRef.current = windowS;

  const setFollow = useCallback((on: boolean) => {
    follow.current = on;
    setFollowing(on);
    dirty.current = true;
  }, []);

  const fitAll = useCallback(() => {
    const v = view.current;
    v.t0 = store.tStart;
    v.t1 = Math.max(store.tStart + MIN_SPAN, store.tEnd);
    for (const r of renderers.current.values()) r.resetRange();
    dirty.current = true;
  }, [store]);

  // A new store (another recording, a reconnect) starts from a clean view.
  useEffect(() => {
    view.current.cursorA = view.current.cursorB = view.current.hoverT = null;
    nextCursor.current = 'A';
    setMeasure(null);
    setTip(null);
    if (live) setFollow(true);
    else fitAll();
  }, [store, live, fitAll, setFollow]);

  useEffect(() => {
    dirty.current = true;
  }, [overlay, lanes, windowS]);

  const updateMeasure = useCallback(() => {
    const { cursorA: a, cursorB: b } = view.current;
    if (a === null || b === null || !store.length) return setMeasure(null);
    const from = store.lowerBound(Math.min(a, b));
    const to = store.lowerBound(Math.max(a, b));
    if (to - from < 2) return setMeasure(null);
    const { ah, wh } = integrate(store, from, to);
    setMeasure({
      dt: store.t[to - 1] - store.t[from], ah, wh,
      vMean: channelStats(store, 'v', from, to).mean,
      iMean: channelStats(store, 'i', from, to).mean,
      pMean: channelStats(store, 'p', from, to).mean,
    });
  }, [store]);

  const clearCursors = useCallback(() => {
    view.current.cursorA = view.current.cursorB = null;
    nextCursor.current = 'A';
    setMeasure(null);
    dirty.current = true;
  }, []);

  const resume = useCallback(() => {
    if (live) setFollow(true);
    else fitAll();
  }, [live, setFollow, fitAll]);

  // One image of every lane, stacked, for sharing.
  const toPng = useCallback((): string | null => {
    const list = [...lanes.map((id) => canvases.current.get(id)), canvases.current.get('axis')].filter(
      (c): c is HTMLCanvasElement => !!c && c.width > 0,
    );
    if (!list.length) return null;
    const out = document.createElement('canvas');
    out.width = Math.max(...list.map((c) => c.width));
    out.height = list.reduce((h, c) => h + c.height, 0);
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = SCOPE_THEME.surface;
    ctx.fillRect(0, 0, out.width, out.height);
    let y = 0;
    for (const c of list) {
      ctx.drawImage(c, 0, y);
      y += c.height;
    }
    return out.toDataURL('image/png');
  }, [lanes]);

  useEffect(() => {
    if (handleRef) handleRef.current = { clearCursors, resume, toPng };
  }, [handleRef, clearCursors, resume, toPng]);

  // Render loop. Draws only when something changed.
  useEffect(() => {
    let raf = 0;
    let lastVersion = -1;
    let lastOverlay = -1;
    const units = { s: t('unit.s'), min: t('unit.min'), h: t('unit.h'), now: t('scope.now') };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const v = view.current;
      if (live && follow.current) {
        const end = store.tEnd;
        const t0 = end - windowRef.current;
        if (v.t1 !== end || v.t0 !== t0) {
          v.t1 = end;
          v.t0 = t0;
          dirty.current = true;
        }
      }
      if (store.version !== lastVersion || (overlay?.version ?? -1) !== lastOverlay) dirty.current = true;
      if (!dirty.current) return;
      dirty.current = false;
      lastVersion = store.version;
      lastOverlay = overlay?.version ?? -1;
      const dpr = window.devicePixelRatio || 1;
      for (const id of lanes) {
        const canvas = canvases.current.get(id);
        if (!canvas) continue;
        let r = renderers.current.get(id);
        if (!r) renderers.current.set(id, (r = new LaneRenderer(LANES[id])));
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        r.draw(ctx, canvas.width / dpr, canvas.height / dpr, store, v, SCOPE_THEME, overlay);
      }
      const axis = canvases.current.get('axis');
      if (axis) {
        const ctx = axis.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawTimeAxis(ctx, axis.width / dpr, axis.height / dpr, v, SCOPE_THEME, {
          relativeTo: live && follow.current ? v.t1 : null,
          units,
        });
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [store, overlay, live, lanes, t]);

  // Axis labels are canvas text; redraw once the web font has arrived.
  useEffect(() => {
    const redraw = () => {
      dirty.current = true;
    };
    document.fonts?.addEventListener('loadingdone', redraw);
    return () => document.fonts?.removeEventListener('loadingdone', redraw);
  }, []);

  // Keep canvas backing stores matched to their CSS size.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      for (const canvas of canvases.current.values()) {
        const w = Math.round(canvas.clientWidth * dpr);
        const h = Math.round(canvas.clientHeight * dpr);
        if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
          canvas.width = w;
          canvas.height = h;
        }
      }
      dirty.current = true;
      // A tooltip placed for the old layout would sit in the wrong spot.
      view.current.hoverT = null;
      setTip(null);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(group);
    return () => ro.disconnect();
  }, [lanes]);

  const plotMetrics = (el: Element) => {
    const rect = el.getBoundingClientRect();
    return { rect, plotW: Math.max(10, rect.width - Y_GUTTER) };
  };

  const clampView = (t0: number, t1: number): [number, number] => {
    let span = Math.max(MIN_SPAN, t1 - t0);
    if (live) span = Math.min(span, LIVE_MAX);
    const lo = store.tStart;
    const hi = Math.max(store.tEnd, lo + MIN_SPAN);
    if (!live) span = Math.min(span, hi - lo);
    if (t0 < lo && !live) t0 = lo;
    if (t0 + span > hi) t0 = hi - span;
    return [t0, t0 + span];
  };

  const showTip = (clientX: number, clientY: number, el: Element) => {
    const { rect, plotW } = plotMetrics(el);
    const x = clientX - rect.left;
    if (x < 0 || x > plotW || !store.length) {
      view.current.hoverT = null;
      setTip(null);
      dirty.current = true;
      return;
    }
    const k = store.nearest(xToTime(x, view.current, plotW));
    view.current.hoverT = store.t[k];
    dirty.current = true;
    const g = groupRef.current!.getBoundingClientRect();
    setTip({ x: clientX - g.left, y: clientY - g.top, sample: store.at(k), flip: clientX - g.left > g.width - 230 });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, t0: view.current.t0, t1: view.current.t1, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      if (!d.moved && Math.abs(dx) < 4) return;
      d.moved = true;
      const { plotW } = plotMetrics(e.currentTarget);
      const shift = (-dx / plotW) * (d.t1 - d.t0);
      const [t0, t1] = clampView(d.t0 + shift, d.t1 + shift);
      view.current.t0 = t0;
      view.current.t1 = t1;
      // Dragging back to the newest data re-attaches a live scope.
      const atEnd = live && t1 >= store.tEnd - (t1 - t0) * 0.01;
      if (follow.current !== atEnd) setFollow(atEnd);
      view.current.hoverT = null;
      setTip(null);
      dirty.current = true;
      return;
    }
    if (e.pointerType !== 'touch') showTip(e.clientX, e.clientY, e.currentTarget);
  };

  const placeCursor = (time: number) => {
    const v = view.current;
    if (nextCursor.current === 'A') {
      v.cursorA = time;
      v.cursorB = null;
      nextCursor.current = 'B';
    } else {
      v.cursorB = time;
      nextCursor.current = 'A';
    }
    dirty.current = true;
    updateMeasure();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || !store.length) return;
    const { rect, plotW } = plotMetrics(e.currentTarget);
    const x = e.clientX - rect.left;
    if (x < 0 || x > plotW) return;
    placeCursor(store.t[store.nearest(xToTime(x, view.current, plotW))]);
    if (e.pointerType === 'touch') showTip(e.clientX, e.clientY, e.currentTarget);
  };

  const onLeave = () => {
    if (drag.current) return;
    view.current.hoverT = null;
    setTip(null);
    dirty.current = true;
  };

  const zoomAt = useCallback((factor: number, anchorT: number | null) => {
    const v = view.current;
    const span = v.t1 - v.t0;
    if (live && follow.current) {
      const next = Math.min(LIVE_MAX, Math.max(1, windowRef.current * factor));
      onWindowChange?.(Math.round(next * 10) / 10);
      return;
    }
    const a = anchorT ?? (v.t0 + v.t1) / 2;
    const ratio = (a - v.t0) / span;
    const nextSpan = span * factor;
    const [t0, t1] = clampView(a - ratio * nextSpan, a - ratio * nextSpan + nextSpan);
    v.t0 = t0;
    v.t1 = t1;
    dirty.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, onWindowChange, store]);

  // Wheel needs a non-passive listener so the page does not scroll while zooming.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const onWheel = (e: WheelEvent) => {
      const el = (e.target as Element).closest?.('.lane-plot');
      if (!el) return;
      // Plain vertical scrolling stays with the page; zoom needs Ctrl, Cmd or a pinch.
      if (!(e.ctrlKey || e.metaKey) && Math.abs(e.deltaX) < Math.abs(e.deltaY)) return;
      e.preventDefault();
      const { rect, plotW } = plotMetrics(el);
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(e.deltaY * 0.0035), xToTime(e.clientX - rect.left, view.current, plotW));
      } else {
        const v = view.current;
        const shift = (e.deltaX / plotW) * (v.t1 - v.t0);
        const [t0, t1] = clampView(v.t0 + shift, v.t1 + shift);
        v.t0 = t0;
        v.t1 = t1;
        if (live) setFollow(t1 >= store.tEnd - (t1 - t0) * 0.01);
        dirty.current = true;
      }
    };
    group.addEventListener('wheel', onWheel, { passive: false });
    return () => group.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomAt, live, store, setFollow]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const v = view.current;
    const step = (v.t1 - v.t0) / 100;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const base = v.hoverT ?? (e.key === 'ArrowLeft' ? v.t1 : v.t0);
      const next = Math.min(v.t1, Math.max(v.t0, base + (e.key === 'ArrowLeft' ? -step : step) * (e.shiftKey ? 10 : 1)));
      if (!store.length) return;
      const k = store.nearest(next);
      v.hoverT = store.t[k];
      dirty.current = true;
      const el = e.currentTarget;
      const { rect, plotW } = plotMetrics(el);
      const g = groupRef.current!.getBoundingClientRect();
      const x = rect.left - g.left + ((v.hoverT - v.t0) / (v.t1 - v.t0)) * plotW;
      setTip({ x, y: rect.top - g.top + 12, sample: store.at(k), flip: x > g.width - 230 });
    } else if (e.key === 'Enter' && v.hoverT !== null) {
      e.preventDefault();
      placeCursor(v.hoverT);
    } else if (e.key === 'Escape') {
      clearCursors();
      onLeave();
    } else if (e.key === '+' || e.key === '=') {
      zoomAt(0.7, v.hoverT);
    } else if (e.key === '-') {
      zoomAt(1 / 0.7, v.hoverT);
    }
  };

  const setCanvas = (id: string) => (el: HTMLCanvasElement | null) => {
    if (el) canvases.current.set(id, el);
    else canvases.current.delete(id);
  };

  const tipRows = useMemo(() => {
    if (!tip) return [];
    const s = tip.sample;
    const rows: { key: string; color: string; dash?: boolean; value: string; label: string }[] = [];
    if (lanes.includes('v')) rows.push({ key: 'v', color: SERIES.v, value: `${num(s.v, 4)} V`, label: t('ch.v') });
    if (lanes.includes('i')) rows.push({ key: 'i', color: SERIES.i, value: `${num(s.i, 4)} A`, label: t('ch.i') });
    if (lanes.includes('p')) rows.push({ key: 'p', color: SERIES.p, value: `${num(s.v * s.i, 3)} W`, label: t('ch.p') });
    if (lanes.includes('d')) {
      rows.push({ key: 'dp', color: SERIES.dp, value: `${num(s.dp, 3)} V`, label: 'D+' });
      rows.push({ key: 'dn', color: SERIES.dn, dash: true, value: `${num(s.dn, 3)} V`, label: 'D−' });
    }
    if (lanes.includes('temp')) rows.push({ key: 't', color: SERIES.temp, value: `${num(s.temp, 1)} °C`, label: t('ch.temp') });
    return rows;
  }, [tip, lanes, t]);

  const hover = tip?.sample ?? null;
  const mAh = measure ? charge(measure.ah) : null;
  const mWh = measure ? energy(measure.wh) : null;

  return (
    <section className="scope" aria-label={t('scope.label')}>
      <div className="scope-bar">
        {toolbar}
        <div className="grow" />
        {measure && mAh && mWh ? (
          <div className="measure" role="status">
            <span className="measure-tag">{t('scope.between')}</span>
            <span>{clock(measure.dt, true)}</span>
            <span>{num(measure.vMean, 4)} V</span>
            <span>{num(measure.iMean, 4)} A</span>
            <span>{num(measure.pMean, 3)} W</span>
            <span>{mAh.value} {mAh.unit}</span>
            <span>{mWh.value} {mWh.unit}</span>
          </div>
        ) : view.current.cursorA !== null ? (
          <div className="measure" role="status"><span className="measure-tag">{t('scope.pickB')}</span></div>
        ) : null}
        {(measure || view.current.cursorA !== null) && (
          <button className="btn ghost small" onClick={clearCursors}>{t('scope.clearCursors')}</button>
        )}
        {live ? (
          !following && <button className="btn accent small" onClick={() => setFollow(true)}>{t('scope.resume')}</button>
        ) : (
          <button className="btn ghost small" onClick={fitAll}>{t('scope.fit')}</button>
        )}
      </div>

      <div className="lanes" ref={groupRef}>
        {lanes.map((id) => (
          <div className="lane" key={id}>
            <div className="lane-readout">{readout(id, hover)}</div>
            <div
              className="lane-plot"
              style={{ height: LANES[id].height }}
              tabIndex={0}
              role="img"
              aria-label={t(`lane.${id}`)}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => (drag.current = null)}
              onPointerLeave={onLeave}
              onDoubleClick={resume}
              onKeyDown={onKeyDown}
            >
              <canvas ref={setCanvas(id)} />
            </div>
          </div>
        ))}
        <div className="lane lane-axis">
          <div className="lane-readout" />
          <div className="lane-plot axis"><canvas ref={setCanvas('axis')} /></div>
        </div>

        {tip && (
          <div
            className={`tip${tip.flip ? ' flip' : ''}`}
            style={{ left: tip.x, top: Math.max(4, tip.y - 12) }}
            role="tooltip"
          >
            <div className="tip-time">{clock(tip.sample.t - (live ? 0 : store.tStart), true)}</div>
            {tipRows.map((r) => (
              <div className="tip-row" key={r.key}>
                <span className={`key${r.dash ? ' dash' : ''}`} style={{ color: r.color }} />
                <b>{r.value}</b>
                <span className="tip-label">{r.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="scope-hint">{t('scope.hint')}</p>
    </section>
  );
}
