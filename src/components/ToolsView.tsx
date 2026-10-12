import { useState } from 'react';
import { engine } from '../core/engine';
import { channelStats } from '../core/stats';
import type { GuessId } from '../device/detector';
import { charge, energy, num } from '../format';
import { useT } from '../i18n';
import { useSettings } from '../state/settings';
import { useEngine } from '../state/useEngine';
import { Field, NumberInput } from './common';

interface Capture {
  v: number;
  i: number;
}

/** Mean of the last second, so one noisy sample cannot skew the result. */
function captureNow(): Capture | null {
  const n = engine.live.length;
  if (n < 50) return null;
  const from = Math.max(0, n - 100);
  return { v: channelStats(engine.live, 'v', from, n).mean, i: channelStats(engine.live, 'i', from, n).mean };
}

function CableTool() {
  const t = useT();
  const snap = useEngine();
  const [a, setA] = useState<Capture | null>(null);
  const [b, setB] = useState<Capture | null>(null);
  const connected = snap.status === 'connected';
  const lowLoad = (snap.now?.i ?? 0) < 0.3;

  let result: { r: number; loss: number; drop: number; mismatch: boolean } | null = null;
  if (a && b) {
    const i = (a.i + b.i) / 2;
    const drop = a.v - b.v;
    result = { r: drop / i, loss: drop * i, drop, mismatch: Math.abs(a.i - b.i) / i > 0.1 };
  }

  return (
    <div className="panel">
      <div className="panel-head"><h2>{t('cable.title')}</h2></div>
      <p className="muted">{t('cable.intro')}</p>
      <ol className="steps">
        <li>
          <div>{t('cable.step1')}</div>
          <button className="btn ghost" disabled={!connected} onClick={() => setA(captureNow())}>{t('cable.capture')}</button>
          {a && <span className="mono">{num(a.v, 4)} V, {num(a.i, 4)} A</span>}
        </li>
        <li>
          <div>{t('cable.step2')}</div>
          <button className="btn ghost" disabled={!connected || !a} onClick={() => setB(captureNow())}>{t('cable.capture')}</button>
          {b && <span className="mono">{num(b.v, 4)} V, {num(b.i, 4)} A</span>}
        </li>
      </ol>
      {connected && lowLoad && <p className="muted">{t('cable.lowLoad')}</p>}
      {result && (
        result.r > 0 ? (
          <div className="result ok" role="status">
            <div className="result-big">{num(result.r * 1000, 0)} mΩ</div>
            <div>{t('cable.result', { drop: num(result.drop * 1000, 0), loss: num(result.loss, 2) })}</div>
            <div>{t(result.r < 0.15 ? 'cable.good' : result.r < 0.3 ? 'cable.fair' : 'cable.poor')}</div>
            {result.mismatch && <div>{t('cable.mismatch')}</div>}
          </div>
        ) : (
          <div className="result fail" role="status">{t('cable.negative')}</div>
        )
      )}
      {(a || b) && <button className="link" onClick={() => { setA(null); setB(null); }}>{t('cable.reset')}</button>}
    </div>
  );
}

function CostTool() {
  const t = useT();
  const snap = useEngine();
  const price = useSettings((s) => s.price);
  const currency = useSettings((s) => s.currency);
  const set = useSettings((s) => s.set);
  const p = snap.now?.p ?? 0;
  const perHour = (p / 1000) * price;
  const sofar = (snap.wh / 1000) * price;
  const e = energy(snap.wh);
  return (
    <div className="panel">
      <div className="panel-head"><h2>{t('cost.title')}</h2></div>
      <div className="form-grid">
        <Field label={t('cost.price')}>
          <NumberInput value={price} min={0} step={0.01} unit={`${currency}/kWh`} onChange={(v) => set('price', Math.max(0, v))} />
        </Field>
        <Field label={t('cost.currency')}>
          <input type="text" value={currency} maxLength={4} onChange={(ev) => set('currency', ev.target.value)} />
        </Field>
      </div>
      <dl className="kv">
        <dt>{t('cost.session', { e: `${e.value} ${e.unit}` })}</dt><dd>{sofar.toFixed(5)} {currency}</dd>
        <dt>{t('cost.hour', { p: num(p, 2) })}</dt><dd>{perHour.toFixed(4)} {currency}</dd>
        <dt>{t('cost.day')}</dt><dd>{(perHour * 24).toFixed(3)} {currency}</dd>
        <dt>{t('cost.year')}</dt><dd>{(perHour * 24 * 365).toFixed(2)} {currency}</dd>
      </dl>
    </div>
  );
}

function CapacityTool() {
  const t = useT();
  const snap = useEngine();
  const efficiency = useSettings((s) => s.efficiency);
  const set = useSettings((s) => s.set);
  const [manual, setManual] = useState<number | null>(null);
  const wh = manual ?? snap.wh;
  const c = charge(snap.ah);
  return (
    <div className="panel">
      <div className="panel-head"><h2>{t('cap.title')}</h2></div>
      <p className="muted">{t('cap.intro')}</p>
      <div className="form-grid">
        <Field label={t('cap.energy')} hint={manual === null ? t('cap.fromSession', { c: `${c.value} ${c.unit}` }) : undefined}>
          <NumberInput value={Number(wh.toFixed(4))} min={0} step={0.1} unit="Wh" onChange={(v) => setManual(Math.max(0, v))} />
        </Field>
        <Field label={t('cap.efficiency')} hint={t('cap.efficiencyHint')}>
          <NumberInput value={Math.round(efficiency * 100)} min={50} max={100} step={1} unit="%" onChange={(v) => set('efficiency', Math.min(1, Math.max(0.5, v / 100)))} />
        </Field>
      </div>
      {manual !== null && <button className="link" onClick={() => setManual(null)}>{t('cap.useSession')}</button>}
      <dl className="kv">
        {[3.6, 3.7, 3.85].map((cell) => (
          <div key={cell} className="kv-row">
            <dt>{t('cap.cell', { v: cell })}</dt>
            <dd>{num(((wh * efficiency) / cell) * 1000, 0)} mAh</dd>
          </div>
        ))}
        <div className="kv-row"><dt>{t('cap.at5')}</dt><dd>{num((wh / 5) * 1000, 0)} mAh</dd></div>
      </dl>
    </div>
  );
}

const USB_LEVELS = [5, 9, 12, 15, 20, 28, 36, 48];

function LevelTool() {
  const t = useT();
  const snap = useEngine();
  const v = snap.now?.v;
  const level = v !== undefined && v > 3 ? USB_LEVELS.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best)) : null;
  const dev = level && v !== undefined ? ((v - level) / level) * 100 : 0;
  const within = Math.abs(dev) <= 5;
  return (
    <div className="panel">
      <div className="panel-head"><h2>{t('level.title')}</h2></div>
      {level === null ? (
        <p className="muted">{t('level.none')}</p>
      ) : (
        <>
          <div className={`result ${within ? 'ok' : 'fail'}`} role="status">
            <div className="result-big">{level} V {dev >= 0 ? '+' : '−'}{Math.abs(dev).toFixed(2)} %</div>
            <div>{t(within ? 'level.within' : 'level.outside', { lo: (level * 0.95).toFixed(2), hi: (level * 1.05).toFixed(2) })}</div>
          </div>
          <div className="level-bar" aria-hidden="true">
            <span className="level-band" />
            <span className="level-mark" style={{ left: `${Math.min(100, Math.max(0, 50 + dev * 5))}%` }} />
          </div>
          <div className="level-scale"><span>−10 %</span><span>{level} V</span><span>+10 %</span></div>
        </>
      )}
    </div>
  );
}

const SIGNATURES: { id: GuessId; dp: string; dn: string }[] = [
  { id: 'dcp', dp: '0.6', dn: '0.6' },
  { id: 'apple05', dp: '2.0', dn: '2.0' },
  { id: 'apple1', dp: '2.0', dn: '2.7' },
  { id: 'apple21', dp: '2.7', dn: '2.0' },
  { id: 'apple24', dp: '2.7', dn: '2.7' },
  { id: 'samsung2', dp: '1.2', dn: '1.2' },
  { id: 'qc2_5', dp: '0.6', dn: '0' },
  { id: 'qc2_9', dp: '3.3', dn: '0.6' },
  { id: 'qc2_12', dp: '0.6', dn: '0.6' },
  { id: 'qc2_20', dp: '3.3', dn: '3.3' },
  { id: 'qc3', dp: '0.6', dn: '3.3' },
  { id: 'pd', dp: '0', dn: '0' },
];

function SignatureTool() {
  const t = useT();
  const snap = useEngine();
  return (
    <div className="panel wide">
      <div className="panel-head"><h2>{t('sig.title')}</h2></div>
      <p className="muted">{t('sig.intro')}</p>
      <div className="sig-now">
        <span>D+ <b className="mono">{num(snap.now?.dp, 3)} V</b></span>
        <span>D− <b className="mono">{num(snap.now?.dn, 3)} V</b></span>
        <span>VBUS <b className="mono">{num(snap.now?.v, 3)} V</b></span>
        <span>{t('sig.reads')} <b>{t(`guess.${snap.guess}`)}</b></span>
      </div>
      <div className="table-wrap">
        <table className="sig">
          <thead><tr><th>{t('sig.scheme')}</th><th>D+ (V)</th><th>D− (V)</th><th>{t('sig.meaning')}</th></tr></thead>
          <tbody>
            {SIGNATURES.map((s) => (
              <tr key={s.id} className={snap.guess === s.id ? 'active' : ''}>
                <td>{t(`guess.${s.id}`)}{snap.guess === s.id && <span className="badge">{t('sig.match')}</span>}</td>
                <td className="mono">{s.dp}</td>
                <td className="mono">{s.dn}</td>
                <td>{t(`sig.${s.id}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ToolsView() {
  const t = useT();
  return (
    <div className="view">
      <header className="view-head"><h1>{t('nav.tools')}</h1></header>
      <div className="tools">
        <CableTool />
        <LevelTool />
        <CapacityTool />
        <CostTool />
        <SignatureTool />
      </div>
    </div>
  );
}
