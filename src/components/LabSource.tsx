import { useMemo, useState } from 'react';
import { sampleRate } from '../core/dsp';
import {
  allanDeviation, busStates, compareFingerprints, fingerprint, voltageTransitions, type Fingerprint, type TraitId,
} from '../core/lab';
import { newId } from '../core/sessions';
import { clock, dateTime, num } from '../format';
import { useT, type T } from '../i18n';
import { useSettings } from '../state/settings';
import { SERIES } from '../theme';
import type { LabData } from './LabView';
import { MiniChart } from './MiniChart';

type AllanChannel = 'v' | 'i';
const UNIT: Record<AllanChannel, string> = { v: 'V', i: 'A' };

/** A small quantity in the channel's unit, with a micro or milli prefix. */
function small(x: number, unit: string): string {
  if (!Number.isFinite(x)) return '–';
  const a = Math.abs(x);
  if (a < 0.001) return `${(x * 1e6).toFixed(1)} µ${unit}`;
  if (a < 1) return `${(x * 1000).toFixed(3)} m${unit}`;
  return `${x.toFixed(4)} ${unit}`;
}

function traitValue(id: TraitId, f: Fingerprint, t: T): string {
  switch (id) {
    case 'level': return f.voc !== null ? `${num(f.voc, 3)} V` : `${num(f.v, 3)} V @ ${num(f.i, 2)} A`;
    case 'rs': return f.rs !== null ? `${num(f.rs * 1000, 1)} mΩ` : '–';
    case 'ripple': return `${num(f.ripple * 1000, 2)} mV`;
    case 'line': return f.line !== null ? `${num(f.line, 2)} Hz` : t('fp.noLine');
    case 'dp': return `${num(f.dp, 3)} V`;
    case 'dn': return `${num(f.dn, 3)} V`;
    case 'guess': return t(`guess.${f.guess}`);
  }
}

const TRAITS: TraitId[] = ['level', 'rs', 'ripple', 'line', 'dp', 'dn', 'guess'];

function FingerprintPanel({ current }: { current: Fingerprint | null }) {
  const t = useT();
  const lang = useSettings((s) => s.lang);
  const saved = useSettings((s) => s.fingerprints);
  const set = useSettings((s) => s.set);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string | null>(null);

  const scored = useMemo(
    () => saved.map((s) => ({ s, c: current ? compareFingerprints(current, s.fp) : null })).sort((a, b) => (b.c?.score ?? 0) - (a.c?.score ?? 0)),
    [saved, current],
  );
  const chosen = scored.find((x) => x.s.id === picked) ?? scored[0];

  const save = () => {
    if (!current) return;
    const entry = { id: newId(), name: name.trim() || t('fp.defaultName', { n: saved.length + 1 }), at: Date.now(), fp: current };
    set('fingerprints', [...saved, entry]);
    setName('');
    setPicked(entry.id);
  };

  return (
    <div className="panel wide-panel">
      <div className="panel-head"><h2>{t('fp.title')}</h2></div>
      <p className="muted">{t('fp.intro')}</p>
      {current ? (
        <div className="actions">
          <input type="text" value={name} maxLength={40} placeholder={t('fp.name')} aria-label={t('fp.name')} onChange={(e) => setName(e.target.value)} />
          <button className="btn accent" onClick={save}>{t('fp.save')}</button>
        </div>
      ) : <p className="muted">{t('fp.need')}</p>}

      {scored.length > 0 && (
        <div className="fp-grid">
          <ul className="fp-list">
            {scored.map(({ s, c }) => (
              <li key={s.id}>
                <button className={`session${chosen?.s.id === s.id ? ' active' : ''}`} onClick={() => setPicked(s.id)}>
                  <span className="session-name">{s.name}</span>
                  <span className="session-meta">{dateTime(s.at, lang)}</span>
                  {c && (
                    <span className="fp-score">
                      <span className="fp-bar" aria-hidden="true"><span style={{ width: `${c.score}%` }} /></span>
                      <span className="mono">{num(c.score, 0)} %</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {chosen && (
            <div className="fp-detail">
              {chosen.c && (
                <div className={`result ${chosen.c.score >= 85 ? 'ok' : chosen.c.score >= 60 ? 'released' : 'fail'}`} role="status">
                  <div className="result-big">{num(chosen.c.score, 0)} %</div>
                  <div>{t(chosen.c.score >= 85 ? 'fp.same' : chosen.c.score >= 60 ? 'fp.similar' : 'fp.different', { name: chosen.s.name })}</div>
                </div>
              )}
              <div className="table-wrap">
                <table className="stats">
                  <thead>
                    <tr><th>{t('fp.trait')}</th><th>{t('fp.now')}</th><th>{chosen.s.name}</th><th>{t('fp.match')}</th></tr>
                  </thead>
                  <tbody>
                    {TRAITS.map((id) => {
                      const m = chosen.c?.traits.find((x) => x.id === id);
                      return (
                        <tr key={id}>
                          <th scope="row">{t(`fp.trait.${id}`)}</th>
                          <td className={id === 'guess' || id === 'line' ? 'plain' : undefined}>{current ? traitValue(id, current, t) : '–'}</td>
                          <td className={id === 'guess' || id === 'line' ? 'plain' : undefined}>{traitValue(id, chosen.s.fp, t)}</td>
                          {m && m.score !== null ? <td>{num(m.score * 100, 0)} %</td> : <td className="plain muted">{t('fp.skipped')}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button className="link" onClick={() => set('fingerprints', saved.filter((x) => x.id !== chosen.s.id))}>
                {t('fp.delete', { name: chosen.s.name })}
              </button>
            </div>
          )}
        </div>
      )}
      <p className="field-hint">{t('fp.note')}</p>
    </div>
  );
}

export function LabSource({ data }: { data: LabData }) {
  const t = useT();
  const { store, from, to, live, tick } = data;
  const [channel, setChannel] = useState<AllanChannel>('v');

  const fs = useMemo(() => sampleRate(store, from, to) || 100, [store, from, to, tick]);
  const states = useMemo(() => busStates(store, from, to), [store, from, to, tick]);
  const transitions = useMemo(() => voltageTransitions(store, from, to, 0.5, fs), [store, from, to, fs, tick]);
  // A level change inside the window would swamp ripple and noise figures, so
  // the fingerprint and the Allan curve read only what came after the last one.
  const steady = useMemo(() => {
    let t = store.t[from];
    if (states.length) t = Math.max(t, states[states.length - 1].t0 + 0.3);
    if (transitions.length) t = Math.max(t, transitions[transitions.length - 1].t + 1.5);
    return Math.min(to, store.lowerBound(t));
  }, [store, from, to, states, transitions]);
  const trimmed = steady > from;
  const current = useMemo(() => fingerprint(store, steady, to, fs), [store, steady, to, fs, tick]);
  const allan = useMemo(() => {
    const a = allanDeviation(store.channel(channel), steady, to, fs);
    return a ? { a, x: a.tau.map(Math.log10), y: a.adev.map((v) => Math.log10(Math.max(v, 1e-9))) } : null;
  }, [store, steady, to, fs, channel, tick]);

  const offset = live ? 0 : store.tStart;
  const span = states.length ? states[states.length - 1].t1 - states[0].t0 : 0;
  const kind = !allan ? null : allan.a.slope < -0.75 ? 'periodic' : allan.a.slope < -0.35 ? 'white' : allan.a.slope < 0.15 ? 'flicker' : 'drift';
  const stillFalling = !!allan && allan.a.best.tau === allan.a.tau[allan.a.tau.length - 1];
  const unit = UNIT[channel];
  const at1s = allan ? allan.a.adev[allan.a.tau.findIndex((x) => x >= 1)] : NaN;

  return (
    <div className="analysis-grid">
      {trimmed && <div className="notice wide-panel">{t('lab.steady', { d: num(store.t[to - 1] - store.t[Math.min(steady, to - 1)], 1) })}</div>}
      <FingerprintPanel current={current} />

      <div className="panel wide-panel">
        <div className="panel-head"><h2>{t('bus.title')}</h2></div>
        <p className="muted">{t('bus.intro')}</p>
        {states.length > 0 && span > 0 && (
          <div className="bus-strip" aria-hidden="true">
            {states.map((s, k) => (
              <span key={k} className={k % 2 ? 'alt' : ''} style={{ flexGrow: Math.max(s.t1 - s.t0, span * 0.02) }} title={t(`guess.${s.id}`)}>
                {t(`guess.${s.id}`)}
              </span>
            ))}
          </div>
        )}
        <div className="table-wrap">
          <table className="stats">
            <thead>
              <tr><th>{t('bus.start')}</th><th>{t('bus.dur')}</th><th>{t('bus.state')}</th><th>VBUS</th><th>D+</th><th>D−</th></tr>
            </thead>
            <tbody>
              {states.map((s, k) => (
                <tr key={k}>
                  <th scope="row">{clock(s.t0 - offset, true)}</th>
                  <td>{num(s.t1 - s.t0, 2)} {t('unit.s')}</td>
                  <td className="plain">{t(`guess.${s.id}`)}</td>
                  <td>{num(s.v, 3)} V</td><td>{num(s.dp, 3)} V</td><td>{num(s.dn, 3)} V</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>{t('bus.trans')}</h3>
        {transitions.length ? (
          <div className="table-wrap">
            <table className="stats">
              <thead>
                <tr><th>{t('bus.start')}</th><th>{t('bus.change')}</th><th>ΔV</th><th>{t('bus.rise')}</th><th>{t('bus.slew')}</th><th>{t('bus.overshoot')}</th></tr>
              </thead>
              <tbody>
                {transitions.map((x, k) => (
                  <tr key={k}>
                    <th scope="row">{clock(x.t - offset, true)}</th>
                    <td>{num(x.from, 3)} → {num(x.to, 3)} V</td>
                    <td>{x.to >= x.from ? '+' : '−'}{num(Math.abs(x.to - x.from), 3)} V</td>
                    <td>{Number.isFinite(x.rise) ? `${num(x.rise * 1000, 0)} ms` : '–'}</td>
                    <td>{Number.isFinite(x.slew) ? `${num(x.slew, 1)} V/${t('unit.s')}` : '–'}</td>
                    <td>{num(x.overshoot * 1000, 0)} mV</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">{t('bus.transNone')}</p>}
        <p className="field-hint">{t('bus.note')}</p>
      </div>

      <div className="panel wide-panel">
        <div className="panel-head">
          <h2>{t('allan.title')}</h2>
          <div className="grow" />
          <div className="seg" role="group" aria-label={t('an.channel')}>
            {(['v', 'i'] as AllanChannel[]).map((c) => (
              <button key={c} className={channel === c ? 'on' : ''} aria-pressed={channel === c} onClick={() => setChannel(c)}>{t(`ch.${c}`)}</button>
            ))}
          </div>
        </div>
        <p className="muted">{t('allan.intro')}</p>
        {allan && kind ? (
          <div className="split">
            <MiniChart
              kind="line" x={allan.x} y={allan.y} color={SERIES[channel]} height={240}
              xTitle={`log₁₀ τ (${t('unit.s')})`} yTitle={`log₁₀ σ (${unit})`} ariaLabel={t('allan.title')}
              tip={(k) => [small(allan.a.adev[k], unit), `τ = ${num(allan.a.tau[k], 2)} ${t('unit.s')}`]}
            />
            <div className="split-side">
              <div className="result ok" role="status">
                <div>{t('allan.best')}</div>
                <div className="result-big">{num(allan.a.best.tau, allan.a.best.tau < 10 ? 2 : 0)} {t('unit.s')}</div>
                <div>{t(stillFalling ? 'allan.bestOpen' : 'allan.bestNote', { sigma: small(allan.a.best.adev, unit) })}</div>
              </div>
              <dl className="kv dense">
                <div className="kv-row"><dt>{t('allan.single')}</dt><dd>{small(allan.a.adev[0], unit)}</dd></div>
                <div className="kv-row"><dt>{t('allan.at1s')}</dt><dd>{small(at1s, unit)}</dd></div>
                <div className="kv-row"><dt>{t('allan.slope')}</dt><dd>{num(allan.a.slope, 2)}</dd></div>
                <div className="kv-row"><dt>{t('allan.n')}</dt><dd>{allan.a.n}</dd></div>
              </dl>
              <p>{t(`allan.kind.${kind}`)}</p>
            </div>
          </div>
        ) : <p className="muted">{t('an.emptyWait')}</p>}
        <p className="field-hint">{t('allan.note')}</p>
      </div>
    </div>
  );
}
