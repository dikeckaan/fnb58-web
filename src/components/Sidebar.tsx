import { Activity, AudioWaveform, FlaskConical, FolderOpen, Settings as Cog, Wrench, Zap } from 'lucide-react';
import { useState } from 'react';
import { engine } from '../core/engine';
import { webHidSupported } from '../device/webhid';
import { useT } from '../i18n';
import { connectMeter, connectSimulator } from '../state/connection';
import { useSettings, type Tab } from '../state/settings';
import { useEngine } from '../state/useEngine';

const TABS: { id: Tab; icon: typeof Activity }[] = [
  { id: 'live', icon: Activity },
  { id: 'analysis', icon: AudioWaveform },
  { id: 'lab', icon: FlaskConical },
  { id: 'recordings', icon: FolderOpen },
  { id: 'trigger', icon: Zap },
  { id: 'tools', icon: Wrench },
  { id: 'settings', icon: Cog },
];

export function Sidebar() {
  const t = useT();
  const snap = useEngine();
  const tab = useSettings((s) => s.tab);
  const set = useSettings((s) => s.set);
  const scenario = useSettings((s) => s.scenario);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const supported = webHidSupported();

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connected = snap.status === 'connected';
  const sim = snap.transport?.kind === 'sim';
  const recording = snap.rec.state !== 'idle';

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-name">FNB58</div>
        <div className="brand-sub">{t('app.subtitle')}</div>
      </div>

      <nav className="nav" aria-label={t('nav.label')}>
        {TABS.map(({ id, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item${tab === id ? ' active' : ''}`}
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => set('tab', id)}
          >
            <Icon size={18} aria-hidden="true" />
            <span>{t(`nav.${id}`)}</span>
            {id === 'live' && recording && <span className="rec-dot" aria-label={t('rec.recording')} />}
          </button>
        ))}
      </nav>

      <div className="grow" />

      <div className="device-card">
        {connected ? (
          <>
            <div className="device-state">
              <span className={`dot ${sim ? 'sim' : 'ok'}`} />
              <span>{sim ? t('dev.simRunning') : t('dev.connected', { name: snap.device?.model ?? 'FNB58' })}</span>
            </div>
            {!sim && snap.device?.firmware && <div>{t('dev.firmware', { v: snap.device.firmware })}</div>}
            {sim && <div>{t(`sim.${scenario}`)}</div>}
            <div>{t('dev.rate', { n: Math.round(snap.diag.rate) })}</div>
            <div>{snap.diag.crcErrors ? t('dev.errors', { n: snap.diag.crcErrors }) : t('dev.noErrors')}</div>
            <button className="btn ghost block" disabled={busy} onClick={() => run(() => engine.disconnect())}>
              {sim ? t('dev.stopSim') : t('dev.disconnect')}
            </button>
          </>
        ) : (
          <>
            <div className="device-state">
              <span className="dot off" />
              <span>{snap.status === 'connecting' ? t('dev.connecting') : t('dev.none')}</span>
            </div>
            {supported ? (
              <button className="btn accent block" disabled={busy} onClick={() => run(connectMeter)}>
                {t('dev.connect')}
              </button>
            ) : (
              <p className="device-note">{t('dev.unsupported')}</p>
            )}
            <button className="btn ghost block" disabled={busy} onClick={() => run(connectSimulator)}>
              {t('dev.startSim')}
            </button>
            {error && <p className="device-error" role="alert">{t('dev.failed', { msg: error })}</p>}
          </>
        )}
      </div>
    </aside>
  );
}
