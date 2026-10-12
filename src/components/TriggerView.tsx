import { ArrowDown, ArrowUp, Download, FileUp, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../core/engine';
import { downloadBlob } from '../core/exporters';
import { SequenceRunner, type Step } from '../core/sequence';
import { newId } from '../core/sessions';
import { isValidTrigger, snapTrigger, TRIGGER_PROTOCOLS, type TriggerProtocol } from '../device/protocol';
import { num, timeOfDay } from '../format';
import { useT } from '../i18n';
import { useSettings } from '../state/settings';
import { useEngine } from '../state/useEngine';
import { Num, NumberInput, Toggle } from './common';

type Result = { kind: 'ok' | 'fail' | 'released' | 'busy'; text: string } | null;

const volts = (mv: number) => (mv / 1000).toFixed(mv % 1000 === 0 ? 0 : 2);

function VoltagePicker({ p, value, onChange }: { p: TriggerProtocol; value: number; onChange(mv: number): void }) {
  const t = useT();
  if (p.fixed) {
    return (
      <div className="volt-grid" role="group" aria-label={t('trig.voltage')}>
        {p.fixed.map((mv) => (
          <button key={mv} className={`volt${mv === value ? ' on' : ''}`} aria-pressed={mv === value} onClick={() => onChange(mv)}>
            {volts(mv)} V
          </button>
        ))}
      </div>
    );
  }
  const r = p.range!;
  return (
    <div className="volt-range">
      <input
        type="range" min={r.min} max={r.max} step={r.step} value={value}
        aria-label={t('trig.voltage')}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="volt-range-row">
        <button className="btn ghost small" onClick={() => onChange(snapTrigger(p, value - r.step))} aria-label={t('trig.stepDown')}>−{r.step} mV</button>
        <NumberInput value={value / 1000} min={r.min / 1000} max={r.max / 1000} step={r.step / 1000} unit="V" aria-label={t('trig.voltage')} onChange={(v) => onChange(snapTrigger(p, Math.round(v * 1000)))} />
        <button className="btn ghost small" onClick={() => onChange(snapTrigger(p, value + r.step))} aria-label={t('trig.stepUp')}>+{r.step} mV</button>
      </div>
      <div className="field-hint">{t('trig.rangeHint', { min: volts(r.min), max: volts(r.max), step: r.step })}</div>
    </div>
  );
}

export function TriggerView() {
  const t = useT();
  const snap = useEngine();
  const accepted = useSettings((s) => s.triggerAccepted);
  const plan = useSettings((s) => s.plan);
  const loop = useSettings((s) => s.planLoop);
  const set = useSettings((s) => s.set);
  const [proto, setProto] = useState<TriggerProtocol>(TRIGGER_PROTOCOLS[0]);
  const [mv, setMv] = useState(5000);
  const [result, setResult] = useState<Result>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [activeStep, setActiveStep] = useState(-1);
  const [planError, setPlanError] = useState('');
  const runner = useMemo(() => new SequenceRunner(engine), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const connected = snap.status === 'connected';

  useEffect(() => () => runner.stop(), [runner]);
  // Losing the meter mid-plan must not leave the UI showing a running plan.
  useEffect(() => {
    if (!connected) runner.stop();
  }, [connected, runner]);

  const pick = (p: TriggerProtocol) => {
    setProto(p);
    setMv(isValidTrigger(p, mv) ? mv : snapTrigger(p, 5000));
    setResult(null);
  };

  const fire = async () => {
    setBusy(true);
    setResult({ kind: 'busy', text: t('trig.asking', { p: proto.name, v: volts(mv) }) });
    const ok = await engine.trigger(proto, mv, 5000);
    setResult(ok
      ? { kind: 'ok', text: t('trig.ok', { p: proto.name, v: volts(mv) }) }
      : { kind: 'fail', text: t('trig.fail') });
    setBusy(false);
  };

  const release = async () => {
    await engine.release();
    setResult({ kind: 'released', text: t('trig.released') });
  };

  const setPlan = (next: Step[]) => set('plan', next);
  const patchStep = (id: string, p: Partial<Step>) => setPlan(plan.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const addStep = () => setPlan([...plan, { id: newId(), protocol: proto.id, millivolts: mv, holdMs: 2000 }]);
  const move = (k: number, d: number) => {
    const next = [...plan];
    const [s] = next.splice(k, 1);
    next.splice(k + d, 0, s);
    setPlan(next);
  };

  const runPlan = () => {
    setRunning(true);
    setPlanError('');
    setActiveStep(-1);
    void runner.run(plan, loop, {
      onStep: (k, ok) => {
        setActiveStep(k);
        if (!ok) setPlanError(t('plan.stepFailed', { n: k + 1 }));
      },
      onEnd: () => {
        setRunning(false);
        setActiveStep(-1);
      },
    });
  };

  const importPlan = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    try {
      const raw = JSON.parse(await f.text()) as { steps?: Partial<Step>[] };
      const steps = (raw.steps ?? []).flatMap((s): Step[] => {
        const p = TRIGGER_PROTOCOLS.find((x) => x.id === s.protocol);
        if (!p || typeof s.millivolts !== 'number') return [];
        return [{ id: newId(), protocol: p.id, millivolts: snapTrigger(p, s.millivolts), holdMs: Math.max(0, Number(s.holdMs) || 0) }];
      });
      if (!steps.length) throw new Error('empty');
      setPlan(steps);
      setPlanError('');
    } catch {
      setPlanError(t('plan.importFailed'));
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const total = plan.reduce((s, x) => s + x.holdMs, 0);
  const trigLog = snap.log.filter((e) => e.kind === 'trigger' || e.kind === 'triggerFail' || e.kind === 'release');

  return (
    <div className="view">
      <header className="view-head"><h1>{t('trig.title')}</h1></header>

      <div className="caution" role="note">
        <TriangleAlert size={22} aria-hidden="true" />
        <div>
          <p><b>{t('trig.cautionTitle')}</b></p>
          <p>{t('trig.caution1')}</p>
          <p>{t('trig.caution2')}</p>
          <Toggle checked={accepted} onChange={(v) => set('triggerAccepted', v)} label={t('trig.accept')} />
        </div>
      </div>

      <div className="trigger-grid">
        <div className="panel">
          <div className="panel-head"><h2>{t('trig.single')}</h2></div>
          <div className="seg wrap" role="group" aria-label={t('trig.protocol')}>
            {TRIGGER_PROTOCOLS.map((p) => (
              <button key={p.id} className={p.id === proto.id ? 'on' : ''} aria-pressed={p.id === proto.id} onClick={() => pick(p)}>{p.name}</button>
            ))}
          </div>
          <VoltagePicker p={proto} value={mv} onChange={setMv} />
          <div className="actions">
            <button className="btn accent big" disabled={!connected || !accepted || busy || running} onClick={() => void fire()}>
              {t('trig.request', { v: volts(mv) })}
            </button>
            <button className="btn ghost big" disabled={!connected || running} onClick={() => void release()}>{t('trig.release')}</button>
          </div>
          {!connected && <p className="muted">{t('trig.needDevice')}</p>}
          {connected && !accepted && <p className="muted">{t('trig.needAccept')}</p>}
          {result && <div className={`result ${result.kind}`} role="status">{result.text}</div>}
        </div>

        <div className="panel vbus">
          <div className="panel-head"><h2>{t('trig.now')}</h2></div>
          <div className="vbus-value"><Num>{num(snap.now?.v, 3)}</Num><span>V</span></div>
          <div className="vbus-sub">
            <span>{num(snap.now?.i, 3)} A</span>
            <span>D+ {num(snap.now?.dp, 2)} V</span>
            <span>D− {num(snap.now?.dn, 2)} V</span>
          </div>
          <div className="stat-note">{t(`guess.${snap.guess}`)}</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>{t('plan.title')}</h2>
          <div className="grow" />
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => void importPlan(e.target.files)} />
          <button className="btn ghost small" onClick={() => fileRef.current?.click()}><FileUp size={15} aria-hidden="true" />{t('plan.import')}</button>
          <button className="btn ghost small" disabled={!plan.length} onClick={() => downloadBlob([JSON.stringify({ format: 'fnb58-plan/1', steps: plan.map(({ id: _id, ...s }) => s) }, null, 2)], 'fnb58-plan.json', 'application/json')}>
            <Download size={15} aria-hidden="true" />{t('plan.export')}
          </button>
        </div>
        <p className="muted">{t('plan.intro')}</p>

        {plan.length > 0 && (
          <div className="table-wrap">
            <table className="plan">
              <thead>
                <tr><th>{t('plan.step')}</th><th>{t('trig.protocol')}</th><th>{t('trig.voltage')}</th><th>{t('plan.hold')}</th><th><span className="sr-only">{t('plan.actions')}</span></th></tr>
              </thead>
              <tbody>
                {plan.map((s, k) => {
                  const p = TRIGGER_PROTOCOLS.find((x) => x.id === s.protocol)!;
                  return (
                    <tr key={s.id} className={k === activeStep ? 'active' : ''}>
                      <td className="mono">{k + 1}</td>
                      <td>
                        <select value={s.protocol} disabled={running} aria-label={t('trig.protocol')} onChange={(e) => {
                          const np = TRIGGER_PROTOCOLS.find((x) => x.id === e.target.value)!;
                          patchStep(s.id, { protocol: np.id, millivolts: snapTrigger(np, s.millivolts) });
                        }}>
                          {TRIGGER_PROTOCOLS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </select>
                      </td>
                      <td>
                        {p.fixed ? (
                          <select value={s.millivolts} disabled={running} aria-label={t('trig.voltage')} onChange={(e) => patchStep(s.id, { millivolts: Number(e.target.value) })}>
                            {p.fixed.map((x) => <option key={x} value={x}>{volts(x)} V</option>)}
                          </select>
                        ) : (
                          <NumberInput value={s.millivolts / 1000} min={p.range!.min / 1000} max={p.range!.max / 1000} step={p.range!.step / 1000} unit="V" disabled={running} aria-label={t('trig.voltage')} onChange={(v) => patchStep(s.id, { millivolts: snapTrigger(p, Math.round(v * 1000)) })} />
                        )}
                      </td>
                      <td><NumberInput value={s.holdMs} min={0} max={3_600_000} step={100} unit="ms" disabled={running} aria-label={t('plan.hold')} onChange={(v) => patchStep(s.id, { holdMs: Math.max(0, Math.round(v)) })} /></td>
                      <td className="row-actions">
                        <button className="icon-btn" disabled={running || k === 0} aria-label={t('plan.up')} onClick={() => move(k, -1)}><ArrowUp size={16} /></button>
                        <button className="icon-btn" disabled={running || k === plan.length - 1} aria-label={t('plan.down')} onClick={() => move(k, 1)}><ArrowDown size={16} /></button>
                        <button className="icon-btn" disabled={running} aria-label={t('plan.remove')} onClick={() => setPlan(plan.filter((x) => x.id !== s.id))}><Trash2 size={16} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="actions">
          <button className="btn ghost" disabled={running} onClick={addStep}><Plus size={16} aria-hidden="true" />{t('plan.add', { p: proto.name, v: volts(mv) })}</button>
          <Toggle checked={loop} onChange={(v) => set('planLoop', v)} label={t('plan.loop')} />
          <div className="grow" />
          {plan.length > 0 && <span className="muted mono">{t('plan.total', { s: (total / 1000).toFixed(1) })}</span>}
          {running ? (
            <button className="btn danger" onClick={() => runner.stop()}>{t('plan.stop')}</button>
          ) : (
            <button className="btn accent" disabled={!connected || !accepted || !plan.some((s) => s.holdMs > 0)} onClick={runPlan}>{t('plan.start')}</button>
          )}
        </div>
        {planError && <div className="result fail" role="alert">{planError}</div>}
      </div>

      {trigLog.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h2>{t('trig.history')}</h2></div>
          <ul className="log">
            {trigLog.slice(0, 30).map((e, k) => (
              <li key={`${e.at}-${k}`} className={e.kind === 'triggerFail' ? 'warn' : ''}>
                <span className="log-time">{timeOfDay(e.at)}</span>
                <span>{t(`log.${e.kind}`, { d: e.detail ?? '' })}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
