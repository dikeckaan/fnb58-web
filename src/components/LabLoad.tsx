import { useMemo } from 'react';
import { batteryLifeHours, chargeForecast, dutyProfile, viDensity } from '../core/lab';
import { integrate } from '../core/stats';
import { charge, clock, num } from '../format';
import { useT, type T } from '../i18n';
import { useSettings } from '../state/settings';
import { SERIES } from '../theme';
import { Field, NumberInput } from './common';
import { DensityPlot } from './DensityPlot';
import type { LabData } from './LabView';
import { MiniChart } from './MiniChart';

/** Current with the prefix that keeps three or four significant figures. */
export function amps(a: number): string {
  if (!Number.isFinite(a)) return '–';
  const x = Math.abs(a);
  if (x < 0.001) return `${(a * 1e6).toFixed(0)} µA`;
  if (x < 1) return `${(a * 1000).toFixed(x < 0.01 ? 3 : x < 0.1 ? 2 : 1)} mA`;
  return `${a.toFixed(3)} A`;
}

function life(hours: number, t: T): string {
  if (!Number.isFinite(hours)) return '–';
  if (hours < 1) return `${Math.round(hours * 60)} ${t('unit.min')}`;
  if (hours < 72) return `${hours.toFixed(1)} ${t('unit.h')}`;
  const days = hours / 24;
  if (days < 90) return `${days.toFixed(1)} ${t('unit.day')}`;
  if (days < 730) return `${(days / 30.44).toFixed(1)} ${t('unit.month')}`;
  return `${(days / 365.25).toFixed(1)} ${t('unit.year')}`;
}

const CELLS = [
  { id: 'cr2032', mah: 225 },
  { id: 'aaa', mah: 1000 },
  { id: 'aa', mah: 2500 },
  { id: '18650', mah: 3000 },
  { id: 'lipo', mah: 500 },
];

export function LabLoad({ data }: { data: LabData }) {
  const t = useT();
  const battery = useSettings((s) => s.battery);
  const cutoffMa = useSettings((s) => s.cutoffMa);
  const set = useSettings((s) => s.set);
  const { store, from, to, live, tick } = data;

  const duty = useMemo(() => dutyProfile(store, from, to), [store, from, to, tick]);
  const density = useMemo(() => viDensity(store, from, to), [store, from, to, tick]);
  // The forecast needs the plateau as well as the tail, so it always reads the whole buffer.
  const charging = useMemo(() => {
    const f = chargeForecast(store, 0, store.length, cutoffMa / 1000);
    return f ? { f, delivered: integrate(store, 0, store.length).ah } : null;
  }, [store, cutoffMa, tick]);

  const mean = useMemo(() => {
    let s = 0;
    for (let k = from; k < to; k++) s += store.i[k];
    return s / (to - from);
  }, [store, from, to, tick]);
  const average = duty ? duty.average : mean;
  const hours = batteryLifeHours(average, battery);
  const sleepShare = duty && duty.average > 0 ? (duty.sleep * (1 - duty.duty)) / duty.average : NaN;
  const f = charging?.f;
  const total = f?.remainingAh != null && charging ? charging.delivered + f.remainingAh : NaN;

  return (
    <div className="analysis-grid">
      <div className="panel">
        <div className="panel-head"><h2>{t('duty.title')}</h2></div>
        <p className="muted">{t('duty.intro')}</p>
        {duty ? (
          <dl className="kv dense">
            <div className="kv-row"><dt>{t('duty.sleep')}</dt><dd>{amps(duty.sleep)}</dd></div>
            <div className="kv-row"><dt>{t('duty.active')}</dt><dd>{amps(duty.active)}</dd></div>
            <div className="kv-row"><dt>{t('duty.peak')}</dt><dd>{amps(duty.peak)}</dd></div>
            <div className="kv-row"><dt>{t('duty.duty')}</dt><dd>{num(duty.duty * 100, 2)} %</dd></div>
            <div className="kv-row"><dt>{t('duty.period')}</dt><dd>{duty.period === null ? '–' : `${num(duty.period, 2)} ${t('unit.s')}`}</dd></div>
            <div className="kv-row"><dt>{t('duty.activeTime')}</dt><dd>{num(duty.activeTime * 1000, 0)} ms</dd></div>
            <div className="kv-row"><dt>{t('duty.qEvent')}</dt><dd>{num(duty.chargePerEvent * 1000, 3)} mC</dd></div>
            <div className="kv-row"><dt>{t('duty.eEvent')}</dt><dd>{num(duty.energyPerEvent * 1000, 2)} mJ</dd></div>
            <div className="kv-row"><dt>{t('duty.events')}</dt><dd>{duty.events}</dd></div>
          </dl>
        ) : <p className="muted">{t('duty.none')}</p>}

        <div className="result ok" role="status">
          <div>{t('duty.avg')}</div>
          <div className="result-big">{amps(average)}</div>
          <div>{t('duty.life', { life: life(hours, t) })}</div>
          {Number.isFinite(sleepShare) && <div>{t(sleepShare >= 0.5 ? 'duty.sleepWins' : 'duty.activeWins', { pct: num((sleepShare >= 0.5 ? sleepShare : 1 - sleepShare) * 100, 0) })}</div>}
        </div>

        <div className="chips" role="group" aria-label={t('duty.cells')}>
          {CELLS.map((c) => (
            <button key={c.id} className={`chip${battery.capacityMah === c.mah ? ' on' : ''}`} aria-pressed={battery.capacityMah === c.mah} onClick={() => set('battery', { ...battery, capacityMah: c.mah })}>
              {t(`cell.${c.id}`)}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <Field label={t('duty.capacity')}>
            <NumberInput value={battery.capacityMah} min={1} step={10} unit="mAh" onChange={(v) => set('battery', { ...battery, capacityMah: Math.max(1, v) })} />
          </Field>
          <Field label={t('duty.usable')} hint={t('duty.usableHint')}>
            <NumberInput value={Math.round(battery.usable * 100)} min={10} max={100} step={1} unit="%" onChange={(v) => set('battery', { ...battery, usable: Math.min(1, Math.max(0.1, v / 100)) })} />
          </Field>
          <Field label={t('duty.selfDis')} hint={t('duty.selfDisHint')}>
            <NumberInput value={battery.selfDischargePct} min={0} max={50} step={0.1} unit={`%/${t('unit.month')}`} onChange={(v) => set('battery', { ...battery, selfDischargePct: Math.min(50, Math.max(0, v)) })} />
          </Field>
        </div>
        <p className="field-hint">{t('duty.note')}</p>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>{t('chg.title')}</h2></div>
        <p className="muted">{t('chg.intro')}</p>
        {f ? (
          <>
            <div className={`result ${f.phase === 'idle' ? 'released' : 'ok'}`} role="status">
              <div>{t(`chg.phase.${f.phase}`)}</div>
              {f.eta !== null && f.phase === 'cv' && (
                <>
                  <div className="result-big">{clock(f.eta)}</div>
                  <div>{t('chg.etaNote', { ma: cutoffMa })}</div>
                </>
              )}
            </div>
            <dl className="kv dense">
              {f.phase !== 'idle' && (
                <>
                  <div className="kv-row"><dt>{t('chg.plateau')}</dt><dd>{amps(f.plateau)}</dd></div>
                  <div className="kv-row"><dt>{t('chg.now')}</dt><dd>{amps(f.now)}</dd></div>
                </>
              )}
              <div className="kv-row"><dt>{t('chg.delivered')}</dt><dd>{charge(charging!.delivered).value} {charge(charging!.delivered).unit}</dd></div>
              {f.taperAt !== null && <div className="kv-row"><dt>{t('chg.taperAt')}</dt><dd>{clock(f.taperAt)}</dd></div>}
              {f.tau !== null && (
                <>
                  <div className="kv-row"><dt>{t('chg.tau')}</dt><dd>{num(f.tau, 1)} {t('unit.s')}</dd></div>
                  <div className="kv-row"><dt>R²</dt><dd>{num(f.r2, 4)}</dd></div>
                  <div className="kv-row"><dt>{t('chg.remaining')}</dt><dd>{charge(f.remainingAh ?? NaN).value} {charge(f.remainingAh ?? NaN).unit}</dd></div>
                  <div className="kv-row"><dt>{t('chg.total')}</dt><dd>{charge(total).value} {charge(total).unit}</dd></div>
                </>
              )}
            </dl>
            {f.fit && f.tailT.length > 2 && (
              <MiniChart
                kind="scatter" x={f.tailT} y={f.tailLn} color={SERIES.i} height={190}
                xTitle={t('unit.s')} yTitle="ln A" fit={f.fit} ariaLabel={t('chg.chart')}
                tipAt={(x, y) => [amps(Math.exp(y)), clock(x + (live ? store.tStart : 0))]}
              />
            )}
            {f.r2 !== null && f.r2 < 0.9 && <p className="result fail">{t('chg.weak')}</p>}
          </>
        ) : <p className="muted">{t('chg.none')}</p>}
        <Field label={t('chg.cutoff')} hint={t('chg.cutoffHint')}>
          <NumberInput value={cutoffMa} min={5} max={2000} step={5} unit="mA" onChange={(v) => set('cutoffMa', Math.min(2000, Math.max(5, v)))} />
        </Field>
        <p className="field-hint">{t('chg.note')}</p>
      </div>

      <div className="panel wide-panel">
        <div className="panel-head"><h2>{t('vi.title')}</h2></div>
        {density ? (
          <DensityPlot data={density} total={to - from} ariaLabel={t('vi.title')} dwellLabel={t('vi.dwell')} />
        ) : <p className="muted">{t('an.emptyWait')}</p>}
        <p className="field-hint">{t('vi.note')}</p>
      </div>
    </div>
  );
}
