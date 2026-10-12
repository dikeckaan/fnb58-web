import { useEffect, useMemo, useState } from 'react';
import {
  fullStats, histogram, loadSteps, medianNoise, pulseShape, sampleRate, spectralPeaks, spectrum, thevenin, linearFit,
} from '../core/dsp';
import { engine } from '../core/engine';
import type { Channel, SampleStore } from '../core/sampleStore';
import { listSessions, loadSession, type SessionMeta } from '../core/sessions';
import { integrate } from '../core/stats';
import { charge, clock, energy, num } from '../format';
import { useT } from '../i18n';
import { onLibraryChange } from '../state/connection';
import { useEngine } from '../state/useEngine';
import { SERIES } from '../theme';
import { Key } from './common';
import { MiniChart } from './MiniChart';

type Focus = 'v' | 'i' | 'p';
const UNITS: Record<Channel, string> = { v: 'V', i: 'A', p: 'W', dp: 'V', dn: 'V', temp: '°C' };
const ROWS: Channel[] = ['v', 'i', 'p', 'dp', 'dn', 'temp'];
const SPANS = [10, 60, 300, 0];

const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));
/** Engineering notation with a milli prefix where it reads better. */
function eng(x: number, unit: string, digits = 3): string {
  if (!Number.isFinite(x)) return '–';
  const a = Math.abs(x);
  if (a !== 0 && a < 1 && unit !== '°C') return `${(x * 1000).toFixed(a < 0.001 ? 3 : a < 0.1 ? 2 : 1)} m${unit}`;
  return `${x.toFixed(digits)} ${unit}`;
}

export function AnalysisView() {
  const t = useT();
  const snap = useEngine();
  const [source, setSource] = useState('live');
  const [span, setSpan] = useState(60);
  const [focus, setFocus] = useState<Focus>('v');
  const [minStep, setMinStep] = useState(0.1);
  const [library, setLibrary] = useState<SessionMeta[]>([]);
  const [loaded, setLoaded] = useState<SampleStore | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const load = () => void listSessions().then(setLibrary).catch(() => undefined);
    load();
    return onLibraryChange(load);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    if (source !== 'live') void loadSession(source).then((s) => alive && setLoaded(s));
    return () => {
      alive = false;
    };
  }, [source]);

  // Live analysis is recomputed once a second; a spectrum every frame would be noise.
  useEffect(() => {
    if (source !== 'live') return;
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [source]);

  const store = source === 'live' ? engine.live : loaded;
  const live = source === 'live';

  const r = useMemo(() => {
    if (!store || store.length < 32) return null;
    const to = store.length;
    const from = live && span > 0 ? store.lowerBound(store.tEnd - span) : 0;
    if (to - from < 32) return null;
    const fs = sampleRate(store, from, to);
    const stats = Object.fromEntries(ROWS.map((c) => [c, fullStats(store, c, from, to)])) as Record<Channel, ReturnType<typeof fullStats>>;
    const data = store.channel(focus);
    const sp = spectrum(data, from, to, fs);
    const hist = histogram(data, from, to, 48);
    const th = thevenin(store, from, to);
    const steps = loadSteps(store, from, to, minStep, fs || 100);
    const pulse = pulseShape(store.i, from, to, fs);
    const { ah, wh } = integrate(store, from, to);
    const tempFit = linearFit(store.t, store.temp, from, to);
    // Smallest non-zero difference between neighbours approximates the resolution in use.
    let lsb = Infinity;
    for (let k = from + 1; k < Math.min(to, from + 5000); k++) {
      const d = Math.abs(data[k] - data[k - 1]);
      if (d > 1e-7 && d < lsb) lsb = d;
    }
    return {
      from, to, fs, stats, sp, hist, th, steps, pulse, ah, wh,
      duration: store.t[to - 1] - store.t[from],
      tempSlope: tempFit ? tempFit.slope * 60 : NaN,
      lsb: Number.isFinite(lsb) ? lsb : NaN,
      peaks: sp ? spectralPeaks(sp, 6) : [],
      floor: sp ? medianNoise(sp) : NaN,
      // Copies sized for the charts, so they do not hold the live buffers.
      specX: sp ? Array.from(sp.freq) : [],
      specY: sp ? Array.from(sp.amp, db) : [],
      scatterX: Array.from(store.i.subarray(from, to)),
      scatterY: Array.from(store.v.subarray(from, to)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, live, span, focus, minStep, tick, loaded]);

  const unit = UNITS[focus];
  const fst = r?.stats[focus];
  const cap = r ? charge(r.ah) : null;
  const en = r ? energy(r.wh) : null;

  return (
    <div className="view">
      <header className="view-head">
        <h1>{t('nav.analysis')}</h1>
        <div className="grow" />
        <label className="inline-select">
          <span>{t('an.source')}</span>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="live">{t('an.live')}</option>
            {library.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        {live && (
          <div className="seg" role="group" aria-label={t('an.span')}>
            {SPANS.map((s) => (
              <button key={s} className={span === s ? 'on' : ''} aria-pressed={span === s} onClick={() => setSpan(s)}>
                {s === 0 ? t('an.all') : s >= 60 ? `${s / 60} ${t('unit.min')}` : `${s} ${t('unit.s')}`}
              </button>
            ))}
          </div>
        )}
      </header>

      {!r ? (
        <div className="empty">
          <h2>{t('an.emptyTitle')}</h2>
          <p>{live && snap.status !== 'connected' ? t('an.emptyConnect') : t('an.emptyWait')}</p>
        </div>
      ) : (
        <>
          <div className="notice">
            {t('an.window', {
              n: (r.to - r.from).toLocaleString(), d: clock(r.duration, true), fs: num(r.fs, 2),
              nyq: num(r.fs / 2, 1), c: `${cap!.value} ${cap!.unit}`, e: `${en!.value} ${en!.unit}`,
            })}
          </div>

          <div className="panel">
            <div className="panel-head"><h2>{t('an.stats')}</h2></div>
            <div className="table-wrap">
              <table className="stats">
                <thead>
                  <tr>
                    <th>{t('an.channel')}</th><th>{t('st.mean')}</th><th>{t('st.min')}</th><th>{t('st.max')}</th>
                    <th>{t('st.pp')}</th><th>{t('st.rms')}</th><th>{t('st.ac')}</th><th>{t('st.crest')}</th>
                    <th>{t('st.median')}</th><th>P1</th><th>P99</th><th>{t('st.slew')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((c) => {
                    const s = r.stats[c];
                    const d = c === 'temp' ? 2 : c === 'dp' || c === 'dn' ? 3 : 4;
                    return (
                      <tr key={c}>
                        <th scope="row"><Key channel={c} dash={c === 'dn'} />{t(`chx.${c}`)} <span className="muted">{UNITS[c]}</span></th>
                        {s ? (
                          <>
                            <td>{num(s.mean, d)}</td><td>{num(s.min, d)}</td><td>{num(s.max, d)}</td><td>{num(s.pp, d)}</td>
                            <td>{num(s.rms, d)}</td><td>{num(s.acRms, d + 1)}</td><td>{num(s.crest, 3)}</td>
                            <td>{num(s.median, d)}</td><td>{num(s.p1, d)}</td><td>{num(s.p99, d)}</td><td>{num(s.maxSlew, 2)}</td>
                          </>
                        ) : <td colSpan={11}>–</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="field-hint">{t('an.statsNote')}</p>
          </div>

          <div className="focus-bar">
            <span className="muted">{t('an.focus')}</span>
            <div className="seg" role="group" aria-label={t('an.focus')}>
              {(['v', 'i', 'p'] as Focus[]).map((c) => (
                <button key={c} className={focus === c ? 'on' : ''} aria-pressed={focus === c} onClick={() => setFocus(c)}>{t(`ch.${c}`)}</button>
              ))}
            </div>
          </div>

          <div className="analysis-grid">
            <div className="panel">
              <div className="panel-head"><h2>{t('an.spectrum', { ch: t(`ch.${focus}`) })}</h2></div>
              {r.sp ? (
                <>
                  <MiniChart
                    kind="line" x={r.specX} y={r.specY} color={SERIES[focus]}
                    xTitle="Hz" yTitle={`dB${unit} RMS`}
                    ariaLabel={t('an.spectrum', { ch: t(`ch.${focus}`) })}
                    tip={(k) => [`${num(r.specX[k], 3)} Hz`, `${num(r.specY[k], 1)} dB${unit}`, eng(r.sp!.amp[k], unit) + ' RMS']}
                  />
                  <dl className="kv dense">
                    <div className="kv-row"><dt>{t('sp.n')}</dt><dd className="mono">{r.sp.n}, {t('sp.hann')}</dd></div>
                    <div className="kv-row"><dt>{t('sp.df')}</dt><dd className="mono">{num(r.sp.df * 1000, 2)} mHz</dd></div>
                    <div className="kv-row"><dt>{t('sp.enbw')}</dt><dd className="mono">{num(r.sp.enbw * 1000, 2)} mHz</dd></div>
                    <div className="kv-row"><dt>{t('sp.floor')}</dt><dd className="mono">{eng(r.floor, unit)} RMS, {num(db(r.floor), 1)} dB{unit}</dd></div>
                    <div className="kv-row"><dt>{t('sp.density')}</dt><dd className="mono">{eng(r.floor / Math.sqrt(r.sp.enbw), unit)}/√Hz</dd></div>
                  </dl>
                  {r.peaks.length ? (
                    <div className="table-wrap">
                      <table className="stats">
                        <thead><tr><th>{t('sp.line')}</th><th>Hz</th><th>RMS</th><th>dB{unit}</th><th>{t('sp.above')}</th></tr></thead>
                        <tbody>
                          {r.peaks.map((p, k) => (
                            <tr key={k}>
                              <th scope="row">{k + 1}</th><td>{num(p.freq, 3)}</td><td>{eng(p.amp, unit)}</td>
                              <td>{num(db(p.amp), 1)}</td><td>{num(db(p.amp) - db(r.floor), 1)} dB</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <p className="muted">{t('sp.noLines')}</p>}
                  <p className="field-hint">{t('sp.alias', { nyq: num(r.fs / 2, 1) })}</p>
                </>
              ) : <p className="muted">{t('an.emptyWait')}</p>}
            </div>

            <div className="panel">
              <div className="panel-head"><h2>{t('an.hist', { ch: t(`ch.${focus}`) })}</h2></div>
              {r.hist && fst && (
                <>
                  <MiniChart
                    kind="bars" x={Array.from(r.hist.edges)} y={Array.from(r.hist.counts)} barWidth={r.hist.width}
                    color={SERIES[focus]} xTitle={unit} yTitle={t('hist.count')} yFloorZero
                    ariaLabel={t('an.hist', { ch: t(`ch.${focus}`) })}
                    tip={(k) => [
                      `${r.hist!.counts[k]} ${t('hist.samples')}`,
                      `${num(r.hist!.edges[k], 5)} … ${num(r.hist!.edges[k] + r.hist!.width, 5)} ${unit}`,
                      `${num((r.hist!.counts[k] / (r.to - r.from)) * 100, 2)} %`,
                    ]}
                  />
                  <dl className="kv dense">
                    <div className="kv-row"><dt>{t('hist.sigma')}</dt><dd className="mono">{eng(fst.acRms, unit, 5)}</dd></div>
                    <div className="kv-row"><dt>{t('hist.span98')}</dt><dd className="mono">{eng(fst.p99 - fst.p1, unit, 5)}</dd></div>
                    <div className="kv-row"><dt>{t('hist.bin')}</dt><dd className="mono">{eng(r.hist.width, unit, 5)}</dd></div>
                    <div className="kv-row"><dt>{t('hist.lsb')}</dt><dd className="mono">{eng(r.lsb, unit, 5)}</dd></div>
                    <div className="kv-row"><dt>{t('hist.snr')}</dt><dd className="mono">{fst.acRms > 0 && fst.mean > 0 ? `${num(20 * Math.log10(fst.mean / fst.acRms), 1)} dB` : '–'}</dd></div>
                  </dl>
                  <p className="field-hint">{t('hist.note')}</p>
                </>
              )}
            </div>

            <div className="panel">
              <div className="panel-head"><h2>{t('an.vi')}</h2></div>
              <MiniChart
                kind="scatter" x={r.scatterX} y={r.scatterY} color={SERIES.v} xTitle="A" yTitle="V"
                fit={r.th ? { slope: -r.th.rs, intercept: r.th.voc } : null}
                ariaLabel={t('an.vi')}
                tipAt={(x, y) => [`${num(y, 4)} V`, `${num(x, 4)} A`]}
              />
              {r.th ? (
                <dl className="kv dense">
                  <div className="kv-row"><dt>{t('th.voc')}</dt><dd className="mono">{num(r.th.voc, 4)} V</dd></div>
                  <div className="kv-row"><dt>{t('th.rs')}</dt><dd className="mono">{num(r.th.rs * 1000, 1)} mΩ</dd></div>
                  <div className="kv-row"><dt>R²</dt><dd className="mono">{num(r.th.r2, 4)}</dd></div>
                  <div className="kv-row"><dt>{t('th.range')}</dt><dd className="mono">{num(r.th.iMin, 3)} … {num(r.th.iMax, 3)} A</dd></div>
                  <div className="kv-row"><dt>{t('th.reg')}</dt><dd className="mono">{num(r.th.regulation, 2)} %</dd></div>
                  {r.th.r2 >= 0.8 && r.th.rs > 0 && (
                    <>
                      <div className="kv-row"><dt>{t('th.isc')}</dt><dd className="mono">{num(r.th.voc / r.th.rs, 1)} A</dd></div>
                      <div className="kv-row"><dt>{t('th.pmax')}</dt><dd className="mono">{num((r.th.voc * r.th.voc) / (4 * r.th.rs), 1)} W</dd></div>
                    </>
                  )}
                </dl>
              ) : <p className="muted">{t('th.none')}</p>}
              {r.th && r.th.r2 < 0.8 && <p className="result fail">{t('th.weak')}</p>}
              <p className="field-hint">{t('th.note')}</p>
            </div>

            <div className="panel">
              <div className="panel-head"><h2>{t('an.load')}</h2></div>
              <dl className="kv dense">
                <div className="kv-row"><dt>{t('ld.r')}</dt><dd className="mono">{fst && r.stats.i && r.stats.i.mean > 0.0005 ? `${num(r.stats.v!.mean / r.stats.i.mean, 3)} Ω` : '–'}</dd></div>
                <div className="kv-row"><dt>{t('ld.pavg')}</dt><dd className="mono">{num(r.stats.p?.mean, 4)} W</dd></div>
                <div className="kv-row"><dt>{t('ld.ppk')}</dt><dd className="mono">{num(r.stats.p?.max, 4)} W</dd></div>
                <div className="kv-row"><dt>{t('ld.par')}</dt><dd className="mono">{r.stats.p && r.stats.p.mean > 0 ? num(r.stats.p.max / r.stats.p.mean, 3) : '–'}</dd></div>
                <div className="kv-row"><dt>{t('ld.icrest')}</dt><dd className="mono">{num(r.stats.i?.crest, 3)}</dd></div>
                <div className="kv-row"><dt>{t('ld.iac')}</dt><dd className="mono">{r.stats.i ? eng(r.stats.i.acRms, 'A', 4) : '–'}</dd></div>
                <div className="kv-row"><dt>{t('ld.ripplePct')}</dt><dd className="mono">{r.stats.v && r.stats.v.mean > 0 ? `${num((r.stats.v.pp / r.stats.v.mean) * 100, 3)} %` : '–'}</dd></div>
                <div className="kv-row"><dt>{t('ld.tslope')}</dt><dd className="mono">{num(r.tempSlope, 3)} °C/{t('unit.min')}</dd></div>
                {r.pulse && (
                  <>
                    <div className="kv-row"><dt>{t('ld.duty')}</dt><dd className="mono">{num(r.pulse.duty * 100, 1)} %</dd></div>
                    <div className="kv-row"><dt>{t('ld.freq')}</dt><dd className="mono">{r.pulse.freq ? `${num(r.pulse.freq, 3)} Hz` : '–'}</dd></div>
                    <div className="kv-row"><dt>{t('ld.levels')}</dt><dd className="mono">{num(r.pulse.low, 3)} / {num(r.pulse.high, 3)} A</dd></div>
                  </>
                )}
              </dl>
              {!r.pulse && <p className="muted">{t('ld.noPulse')}</p>}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>{t('an.steps')}</h2>
              <div className="grow" />
              <label className="inline-select">
                <span>{t('step.threshold')}</span>
                <select value={minStep} onChange={(e) => setMinStep(Number(e.target.value))}>
                  {[0.02, 0.05, 0.1, 0.25, 0.5, 1].map((x) => <option key={x} value={x}>{x * 1000} mA</option>)}
                </select>
              </label>
            </div>
            {r.steps.length ? (
              <div className="table-wrap">
                <table className="stats">
                  <thead>
                    <tr>
                      <th>{t('step.at')}</th><th>{t('step.i')}</th><th>ΔI</th><th>{t('step.v')}</th><th>ΔV</th>
                      <th>{t('step.transient')}</th><th>{t('step.settle')}</th><th>{t('step.rout')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.steps.map((s, k) => (
                      <tr key={k}>
                        <th scope="row">{clock(s.t - (live ? 0 : store!.tStart), true)}</th>
                        <td>{num(s.iBefore, 3)} → {num(s.iAfter, 3)} A</td>
                        <td>{s.iAfter >= s.iBefore ? '+' : '−'}{num(Math.abs(s.iAfter - s.iBefore), 3)} A</td>
                        <td>{num(s.vBefore, 3)} → {num(s.vAfter, 3)} V</td>
                        <td>{s.vAfter >= s.vBefore ? '+' : '−'}{num(Math.abs(s.vAfter - s.vBefore) * 1000, 1)} mV</td>
                        <td>{s.transient >= 0 ? '+' : '−'}{num(Math.abs(s.transient) * 1000, 1)} mV</td>
                        <td>{s.settle === null ? `> ${t('step.window')}` : `${num(s.settle * 1000, 0)} ms`}</td>
                        <td>{num(s.rOut * 1000, 1)} mΩ</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted">{t('step.none', { ma: minStep * 1000 })}</p>}
            <p className="field-hint">{t('step.note')}</p>
          </div>

          <div className="panel">
            <div className="panel-head"><h2>{t('an.chain')}</h2></div>
            <div className="table-wrap">
              <table className="stats chain">
                <thead><tr><th>{t('chain.item')}</th><th>{t('chain.value')}</th><th>{t('chain.note')}</th></tr></thead>
                <tbody>
                  <tr><th scope="row">{t('chain.fs')}</th><td>100 Hz, 10 ms</td><td>{t('chain.fsNote')}</td></tr>
                  <tr><th scope="row">{t('chain.nyq')}</th><td>50 Hz</td><td>{t('chain.nyqNote')}</td></tr>
                  <tr><th scope="row">{t('chain.vres')}</th><td>10 µV, u32 / 100000</td><td>{t('chain.vresNote')}</td></tr>
                  <tr><th scope="row">{t('chain.ires')}</th><td>10 µA, u32 / 100000</td><td>{t('chain.iresNote')}</td></tr>
                  <tr><th scope="row">{t('chain.dres')}</th><td>1 mV, u16 / 1000</td><td>{t('chain.dresNote')}</td></tr>
                  <tr><th scope="row">{t('chain.tres')}</th><td>0.1 °C, u16 / 10</td><td>{t('chain.tresNote')}</td></tr>
                  <tr><th scope="row">{t('chain.frame')}</th><td>64 B, 4 × 15 B</td><td>{t('chain.frameNote')}</td></tr>
                  <tr><th scope="row">{t('chain.crc')}</th><td>CRC-8, 0x39</td><td>{t('chain.crcNote')}</td></tr>
                  <tr><th scope="row">{t('chain.int')}</th><td>Σ I Δt, Σ V I Δt</td><td>{t('chain.intNote')}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
