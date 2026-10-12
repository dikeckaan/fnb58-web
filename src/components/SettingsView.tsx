import { useEffect, useState } from 'react';
import { ALARM_KEYS, engine, type AlarmKey } from '../core/engine';
import { deleteSession, listSessions } from '../core/sessions';
import { SCENARIOS } from '../device/simulator';
import { webHidSupported } from '../device/webhid';
import { bytes } from '../format';
import { useT } from '../i18n';
import { libraryChanged } from '../state/connection';
import { useSettings, type Lang } from '../state/settings';
import { beep } from '../state/sound';
import { useEngine } from '../state/useEngine';
import { NumberInput, Toggle } from './common';

const ALARM_UNITS: Record<AlarmKey, string> = { vHigh: 'V', vLow: 'V', iHigh: 'A', pHigh: 'W', tHigh: '°C' };

function Storage() {
  const t = useT();
  const [usage, setUsage] = useState<{ used: number; quota: number; count: number } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const load = () => {
    void Promise.all([navigator.storage?.estimate?.() ?? Promise.resolve({ usage: 0, quota: 0 }), listSessions()]).then(
      ([e, list]) => setUsage({ used: e.usage ?? 0, quota: e.quota ?? 0, count: list.length }),
    ).catch(() => setUsage(null));
  };
  useEffect(load, []);
  return (
    <div className="panel">
      <div className="panel-head"><h2>{t('set.storage')}</h2></div>
      <p className="muted">{t('set.storageIntro')}</p>
      {usage && <p>{t('set.storageUse', { n: usage.count, used: bytes(usage.used), quota: bytes(usage.quota) })}</p>}
      <div className="actions">
        {confirm ? (
          <>
            <button className="btn ghost" onClick={() => setConfirm(false)}>{t('common.cancel')}</button>
            <button
              className="btn danger"
              onClick={async () => {
                for (const m of await listSessions()) await deleteSession(m.id);
                libraryChanged();
                setConfirm(false);
                load();
              }}
            >
              {t('set.deleteAllConfirm', { n: usage?.count ?? 0 })}
            </button>
          </>
        ) : (
          <button className="btn ghost" disabled={!usage?.count} onClick={() => setConfirm(true)}>{t('set.deleteAll')}</button>
        )}
      </div>
    </div>
  );
}

export function SettingsView() {
  const t = useT();
  const snap = useEngine();
  const s = useSettings();
  const setAlarm = (k: AlarmKey, patch: Partial<{ enabled: boolean; limit: number }>) =>
    s.set('alarms', { ...s.alarms, [k]: { ...s.alarms[k], ...patch } });

  return (
    <div className="view">
      <header className="view-head"><h1>{t('nav.settings')}</h1></header>
      <div className="tools">
        <div className="panel">
          <div className="panel-head"><h2>{t('set.general')}</h2></div>
          <div className="field">
            <span className="field-label">{t('set.language')}</span>
            <div className="seg" role="group" aria-label={t('set.language')}>
              {(['tr', 'en'] as Lang[]).map((l) => (
                <button key={l} className={s.lang === l ? 'on' : ''} aria-pressed={s.lang === l} onClick={() => s.set('lang', l)}>
                  {l === 'tr' ? 'Türkçe' : 'English'}
                </button>
              ))}
            </div>
          </div>
          <Toggle checked={s.autoReconnect} onChange={(v) => s.set('autoReconnect', v)} label={t('set.autoReconnect')} />
          <p className="field-hint">{t('set.autoReconnectHint')}</p>
          <div className="field">
            <span className="field-label">{t('set.scenario')}</span>
            <select value={s.scenario} onChange={(e) => s.set('scenario', e.target.value as typeof s.scenario)}>
              {SCENARIOS.map((x) => <option key={x} value={x}>{t(`sim.${x}`)}</option>)}
            </select>
            <span className="field-hint">{t('set.scenarioHint')}</span>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><h2>{t('set.alarms')}</h2></div>
          <p className="muted">{t('set.alarmsIntro')}</p>
          <div className="alarm-rows">
            {ALARM_KEYS.map((k) => (
              <div className="alarm-row" key={k}>
                <Toggle checked={s.alarms[k].enabled} onChange={(v) => setAlarm(k, { enabled: v })} label={t(`alarm.${k}`)} />
                <NumberInput value={s.alarms[k].limit} step={0.1} unit={ALARM_UNITS[k]} aria-label={t(`alarm.${k}`)} onChange={(v) => setAlarm(k, { limit: v })} />
              </div>
            ))}
          </div>
          <div className="actions">
            <Toggle checked={s.sound} onChange={(v) => s.set('sound', v)} label={t('set.sound')} />
            <button className="btn ghost small" onClick={beep}>{t('set.soundTest')}</button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><h2>{t('set.diag')}</h2></div>
          <dl className="kv text">
            <div className="kv-row"><dt>{t('diag.browser')}</dt><dd>{webHidSupported() ? t('diag.hidYes') : t('diag.hidNo')}</dd></div>
            <div className="kv-row"><dt>{t('diag.link')}</dt><dd>{snap.transport ? `${snap.transport.name} (${snap.transport.kind === 'sim' ? t('diag.sim') : 'WebHID'})` : t('dev.none')}</dd></div>
            {snap.transport?.vendorId !== undefined && (
              <div className="kv-row"><dt>USB</dt><dd className="mono">{snap.transport.vendorId.toString(16).padStart(4, '0')}:{(snap.transport.productId ?? 0).toString(16).padStart(4, '0')}</dd></div>
            )}
            <div className="kv-row"><dt>{t('diag.frames')}</dt><dd className="mono">{snap.diag.frames.toLocaleString()}</dd></div>
            <div className="kv-row"><dt>{t('diag.rate')}</dt><dd className="mono">{Math.round(snap.diag.rate)}</dd></div>
            <div className="kv-row"><dt>{t('diag.crc')}</dt><dd className="mono">{snap.diag.crcErrors}</dd></div>
            <div className="kv-row"><dt>{t('diag.gaps')}</dt><dd className="mono">{snap.diag.gaps}</dd></div>
            <div className="kv-row"><dt>{t('diag.buffer')}</dt><dd className="mono">{engine.live.length.toLocaleString()}</dd></div>
            {snap.device?.firmware && <div className="kv-row"><dt>{t('diag.fw')}</dt><dd className="mono">{snap.device.firmware}</dd></div>}
            {snap.device?.infoHex && <div className="kv-row"><dt>{t('diag.info')}</dt><dd className="mono wrap">{snap.device.infoHex}</dd></div>}
            {snap.diag.lastOther && <div className="kv-row"><dt>{t('diag.other')}</dt><dd className="mono wrap">{snap.diag.lastOther}</dd></div>}
          </dl>
        </div>

        <Storage />

        <div className="panel">
          <div className="panel-head"><h2>{t('set.keys')}</h2></div>
          <dl className="kv text">
            <div className="kv-row"><dt><kbd>R</kbd></dt><dd>{t('keys.record')}</dd></div>
            <div className="kv-row"><dt><kbd>1</kbd> … <kbd>7</kbd></dt><dd>{t('keys.tabs')}</dd></div>
            <div className="kv-row"><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>{t('keys.walk')}</dd></div>
            <div className="kv-row"><dt><kbd>Enter</kbd></dt><dd>{t('keys.cursor')}</dd></div>
            <div className="kv-row"><dt><kbd>+</kbd> <kbd>−</kbd></dt><dd>{t('keys.zoom')}</dd></div>
            <div className="kv-row"><dt><kbd>Esc</kbd></dt><dd>{t('keys.clear')}</dd></div>
          </dl>
        </div>

        <div className="panel">
          <div className="panel-head"><h2>{t('set.about')}</h2></div>
          <p>{t('about.1')}</p>
          <p>{t('about.2')}</p>
          <p className="muted">{t('about.3')}</p>
        </div>
      </div>
    </div>
  );
}
