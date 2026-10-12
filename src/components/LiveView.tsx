import { Circle, Pause, Play, RotateCcw, SlidersHorizontal, Square, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ALARM_KEYS, engine, type RecordConfig, type Snapshot } from '../core/engine';
import type { Sample } from '../core/sampleStore';
import { channelStats } from '../core/stats';
import { charge, clock, energy, num, resistance, timeOfDay } from '../format';
import { useT, type T } from '../i18n';
import { connectMeter, connectSimulator, onRecordingSaved } from '../state/connection';
import { useSettings } from '../state/settings';
import { useEngine } from '../state/useEngine';
import { LANE_IDS, LANES, type LaneId } from '../theme';
import { webHidSupported } from '../device/webhid';
import { Card, Field, Key, Num, NumberInput, Stat } from './common';
import { ScopeGroup } from './ScopeGroup';

const WINDOWS = [10, 60, 300, 900, 3600];

function windowLabel(s: number, t: T): string {
  if (s >= 3600) return `${s / 3600} ${t('unit.h')}`;
  if (s >= 60) return `${s / 60} ${t('unit.min')}`;
  return `${s} ${t('unit.s')}`;
}

export function laneLabel(id: LaneId, t: T): string {
  return t(`ch.${id}`);
}

function LiveReadout({ lane, snap, hover }: { lane: LaneId; snap: Snapshot; hover: Sample | null }) {
  const t = useT();
  const now = snap.now;
  const spec = LANES[lane];
  if (lane === 'd') {
    const dp = hover ? hover.dp : now?.dp;
    const dn = hover ? hover.dn : now?.dn;
    return (
      <>
        <div className="ro-name">{t('ch.d')}</div>
        <div className="ro-pair"><Key channel="dp" /><span className="ro-tag">D+</span><Num>{num(dp, 3)}</Num><span className="ro-unit">V</span></div>
        <div className="ro-pair"><Key channel="dn" dash /><span className="ro-tag">D−</span><Num>{num(dn, 3)}</Num><span className="ro-unit">V</span></div>
      </>
    );
  }
  const live = lane === 'p' ? now?.p : now?.[lane];
  const hov = hover ? (lane === 'p' ? hover.v * hover.i : hover[lane]) : undefined;
  const st = snap.stats?.[lane];
  return (
    <>
      <div className="ro-name"><Key channel={lane} />{t(`ch.${lane}`)}</div>
      <div className={`ro-value${lane === 'temp' ? ' small' : ''}`}>
        <Num>{num(hov ?? live, spec.digits)}</Num>
        <span className="ro-unit">{spec.unit}</span>
      </div>
      {st && (
        <div className="ro-range">
          {t('ro.minmax', { min: num(st.min, Math.min(3, spec.digits)), max: num(st.max, Math.min(3, spec.digits)) })}
        </div>
      )}
    </>
  );
}

function RecordSetup({ onClose }: { onClose(): void }) {
  const t = useT();
  const record = useSettings((s) => s.record);
  const set = useSettings((s) => s.set);
  const patch = (p: Partial<RecordConfig>) => set('record', { ...record, ...p });
  const hours = (8_640_000 / record.rate / 3600).toFixed(0);
  return (
    <div className="panel setup">
      <div className="panel-head">
        <h2>{t('rec.setup')}</h2>
        <button className="btn ghost small" onClick={onClose}>{t('common.close')}</button>
      </div>
      <div className="form-grid">
        <Field label={t('rec.rate')} hint={t('rec.rateHint', { h: hours })}>
          <div className="seg" role="group" aria-label={t('rec.rate')}>
            {([100, 50, 10, 1] as const).map((r) => (
              <button key={r} className={record.rate === r ? 'on' : ''} aria-pressed={record.rate === r} onClick={() => patch({ rate: r })}>
                {r}/{t('unit.s')}
              </button>
            ))}
          </div>
        </Field>
        <Field label={t('rec.startCurrent')} hint={t('rec.startHint')}>
          <NumberInput value={record.startCurrent * 1000} min={0} max={10000} step={10} unit="mA" onChange={(v) => patch({ startCurrent: Math.max(0, v) / 1000 })} />
        </Field>
        <Field label={t('rec.stopCurrent')} hint={t('rec.stopHint')}>
          <NumberInput value={record.stopCurrent * 1000} min={0} max={10000} step={10} unit="mA" onChange={(v) => patch({ stopCurrent: Math.max(0, v) / 1000 })} />
        </Field>
        <Field label={t('rec.stopDelay')} hint={t('rec.delayHint')}>
          <NumberInput value={record.stopDelay} min={1} max={3600} step={1} unit={t('unit.s')} onChange={(v) => patch({ stopDelay: Math.max(1, v) })} />
        </Field>
      </div>
    </div>
  );
}

function RecordControls({ snap, onSetup }: { snap: Snapshot; onSetup(): void }) {
  const t = useT();
  const set = useSettings((s) => s.set);
  const { state } = snap.rec;
  const connected = snap.status === 'connected';
  const [saved, setSaved] = useState(false);

  useEffect(() => onRecordingSaved(() => setSaved(true)), []);
  useEffect(() => {
    if (state !== 'idle') setSaved(false);
  }, [state]);

  if (state === 'idle') {
    return (
      <>
        {saved && (
          <button className="btn ghost" onClick={() => set('tab', 'recordings')}>{t('rec.savedOpen')}</button>
        )}
        <button className="btn ghost" onClick={onSetup}><SlidersHorizontal size={16} aria-hidden="true" />{t('rec.setup')}</button>
        <button
          className="btn accent"
          disabled={!connected}
          onClick={() => engine.startRecording(useSettings.getState().record)}
        >
          <Circle size={12} fill="#9c1c14" stroke="none" aria-hidden="true" />
          {t('rec.start')}
        </button>
      </>
    );
  }
  const c = charge(snap.rec.ah);
  return (
    <>
      <div className={`rec-status ${state}`} role="status">
        <span className="rec-dot" />
        {state === 'armed'
          ? t('rec.armed', { ma: Math.round(engine.recordConfig.startCurrent * 1000) })
          : `${state === 'paused' ? t('rec.paused') : t('rec.recording')} ${clock(snap.rec.duration)}  ${c.value} ${c.unit}`}
      </div>
      {state !== 'armed' && (
        <button className="btn ghost" onClick={() => engine.pauseRecording()}>
          {state === 'paused' ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
          {state === 'paused' ? t('rec.resume') : t('rec.pause')}
        </button>
      )}
      <button className="btn danger" onClick={() => engine.stopRecording()}>
        <Square size={13} fill="currentColor" aria-hidden="true" />
        {state === 'armed' ? t('rec.cancel') : t('rec.stop')}
      </button>
    </>
  );
}

function Welcome() {
  const t = useT();
  const supported = webHidSupported();
  return (
    <div className="welcome">
      <h1>{t('welcome.title')}</h1>
      <p>{supported ? t('welcome.body') : t('welcome.unsupported')}</p>
      <div className="welcome-actions">
        {supported && <button className="btn accent big" onClick={() => void connectMeter().catch(() => undefined)}>{t('dev.connect')}</button>}
        <button className="btn ghost big" onClick={() => void connectSimulator()}>{t('dev.startSim')}</button>
      </div>
      <ol className="welcome-steps">
        <li>{t('welcome.step1')}</li>
        <li>{t('welcome.step2')}</li>
        <li>{t('welcome.step3')}</li>
      </ol>
    </div>
  );
}

function EventLog({ snap }: { snap: Snapshot }) {
  const t = useT();
  if (!snap.log.length) return null;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('log.title')}</h2>
        <button className="btn ghost small" onClick={() => engine.clearLog()}>{t('log.clear')}</button>
      </div>
      <ul className="log">
        {snap.log.slice(0, 40).map((e, k) => (
          <li key={`${e.at}-${k}`} className={e.kind === 'alarm' || e.kind === 'triggerFail' || e.kind === 'error' ? 'warn' : ''}>
            <span className="log-time">{timeOfDay(e.at)}</span>
            <span>{t(`log.${e.kind}`, { d: e.kind === 'alarm' && e.detail ? t(`alarm.${e.detail}`) : e.detail ?? '' })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LiveView() {
  const t = useT();
  const snap = useEngine();
  const windowS = useSettings((s) => s.windowS);
  const lanes = useSettings((s) => s.lanes);
  const set = useSettings((s) => s.set);
  const toggleLane = useSettings((s) => s.toggleLane);
  const [setup, setSetup] = useState(false);
  const connected = snap.status === 'connected';

  // Ripple over the last second, refreshed with the snapshot.
  const ripple = useMemo(() => {
    const n = engine.live.length;
    if (!connected || n < 20) return null;
    return channelStats(engine.live, 'v', Math.max(0, n - 100), n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, connected]);

  if (!connected && engine.live.length === 0) return <Welcome />;

  const now = snap.now;
  const cap = charge(snap.ah);
  const en = energy(snap.wh);
  const res = now ? resistance(now.v, now.i) : { value: '–', unit: 'Ω' };
  const active = ALARM_KEYS.filter((k) => snap.alarms[k]);
  const armedAlarms = ALARM_KEYS.filter((k) => engine.alarmConfig[k].enabled);

  return (
    <div className="view">
      <header className="view-head">
        <div className="session-clock">
          {t('live.session')} <span className="mono"><Num>{clock(snap.elapsed)}</Num></span>
        </div>
        <div className="grow" />
        <button className="btn ghost" onClick={() => engine.resetCounters()} disabled={!connected}>
          <RotateCcw size={16} aria-hidden="true" />{t('live.reset')}
        </button>
        <RecordControls snap={snap} onSetup={() => setSetup((v) => !v)} />
      </header>

      {setup && <RecordSetup onClose={() => setSetup(false)} />}

      {active.length > 0 && (
        <div className="alarm-banner" role="alert">
          <TriangleAlert size={20} aria-hidden="true" />
          <span>{active.map((k) => t(`alarm.${k}.now`, { limit: engine.alarmConfig[k].limit })).join('  ')}</span>
        </div>
      )}

      {!connected && <div className="notice">{t('live.frozen')}</div>}

      <ScopeGroup
        store={engine.live}
        live
        lanes={lanes}
        windowS={windowS}
        onWindowChange={(s) => set('windowS', s)}
        readout={(lane, hover) => <LiveReadout lane={lane} snap={snap} hover={hover} />}
        toolbar={
          <>
            <div className="seg" role="group" aria-label={t('scope.window')}>
              {WINDOWS.map((w) => (
                <button key={w} className={windowS === w ? 'on' : ''} aria-pressed={windowS === w} onClick={() => set('windowS', w)}>
                  {windowLabel(w, t)}
                </button>
              ))}
            </div>
            <div className="chips" role="group" aria-label={t('scope.lanes')}>
              {LANE_IDS.map((id) => (
                <button key={id} className={`chip${lanes.includes(id) ? ' on' : ''}`} aria-pressed={lanes.includes(id)} onClick={() => toggleLane(id)}>
                  <Key channel={id === 'd' ? 'dp' : id} />
                  {t(`ch.${id}.short`)}
                </button>
              ))}
            </div>
          </>
        }
      />

      <div className="cards">
        <Card title={t('card.capacity')}><Stat value={cap.value} unit={cap.unit} /></Card>
        <Card title={t('card.energy')}><Stat value={en.value} unit={en.unit} /></Card>
        <Card title={t('card.avgPower')}>
          <Stat value={num(snap.stats?.p.mean, 3)} unit="W" note={t('card.peak', { v: num(snap.stats?.p.max, 2) })} />
        </Card>
        <Card title={t('card.resistance')}><Stat value={res.value} unit={res.unit} /></Card>
        <Card title={t('card.ripple')}>
          <Stat
            value={ripple ? num(ripple.pp * 1000, 1) : '–'}
            unit="mVpp"
            note={ripple ? t('card.rippleRms', { v: num(ripple.std * 1000, 2) }) : undefined}
          />
        </Card>
        <Card title={t('card.protocol')}>
          <div className="stat text">{t(`guess.${snap.guess}`)}</div>
          <div className="stat-note">{t('card.protocolNote')}</div>
        </Card>
        <Card title={t('card.alarms')}>
          {armedAlarms.length ? (
            <ul className="mini-list">
              {armedAlarms.map((k) => (
                <li key={k} className={snap.alarms[k] ? 'hot' : ''}>{t(`alarm.${k}.rule`, { limit: engine.alarmConfig[k].limit })}</li>
              ))}
            </ul>
          ) : (
            <button className="link" onClick={() => set('tab', 'settings')}>{t('card.alarmsOff')}</button>
          )}
        </Card>
      </div>

      <EventLog snap={snap} />
    </div>
  );
}
