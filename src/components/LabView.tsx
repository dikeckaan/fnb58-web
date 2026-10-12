import { useEffect, useState } from 'react';
import { engine } from '../core/engine';
import type { SampleStore } from '../core/sampleStore';
import { listSessions, loadSession, type SessionMeta } from '../core/sessions';
import { useT } from '../i18n';
import { onLibraryChange } from '../state/connection';
import {
  closeFloating, floatingSupported, openFloating, setListen, setVoice, useGadgets, voiceSupported, type ToneChannel,
} from '../state/gadgets';
import { useSettings, type LabSection } from '../state/settings';
import { useEngine } from '../state/useEngine';
import { Toggle } from './common';
import { LabLoad } from './LabLoad';
import { LabSource } from './LabSource';
import { ScriptConsole } from './ScriptConsole';

const SECTIONS: LabSection[] = ['load', 'source', 'auto'];
const SPANS = [10, 60, 300, 0];
const TONE_CHANNELS: ToneChannel[] = ['i', 'v', 'p'];

/** What a lab panel works on: a store and the index range the user chose. */
export interface LabData {
  store: SampleStore;
  from: number;
  to: number;
  live: boolean;
  /** Changes whenever live data should be re-read. */
  tick: number;
}

function Helpers() {
  const t = useT();
  const g = useGadgets();
  const canFloat = floatingSupported();
  const canSpeak = voiceSupported();
  return (
    <div className="panel">
      <div className="panel-head"><h2>{t('gad.title')}</h2></div>
      <div className="helpers">
        <div className="helper">
          {canFloat ? (
            <button className="btn ghost" onClick={() => (g.floating ? closeFloating() : void openFloating())}>
              {g.floating ? t('gad.floatClose') : t('gad.float')}
            </button>
          ) : null}
          <p className="field-hint">{canFloat ? t('gad.floatHint') : t('gad.floatUnsupported')}</p>
        </div>
        <div className="helper">
          <div className="helper-row">
            <Toggle checked={g.listen} onChange={setListen} label={t('gad.listen')} />
            <div className="seg" role="group" aria-label={t('gad.channel')}>
              {TONE_CHANNELS.map((c) => (
                <button key={c} className={g.channel === c ? 'on' : ''} aria-pressed={g.channel === c} onClick={() => useGadgets.setState({ channel: c })}>
                  {t(`ch.${c}`)}
                </button>
              ))}
            </div>
          </div>
          <p className="field-hint">{t('gad.listenHint')}</p>
        </div>
        <div className="helper">
          {canSpeak && <Toggle checked={g.voice} onChange={setVoice} label={t('gad.voice')} />}
          <p className="field-hint">{canSpeak ? t('gad.voiceHint') : t('gad.voiceUnsupported')}</p>
        </div>
      </div>
    </div>
  );
}

export function LabView() {
  const t = useT();
  const snap = useEngine();
  const section = useSettings((s) => s.labSection);
  const set = useSettings((s) => s.set);
  const [source, setSource] = useState('live');
  const [span, setSpan] = useState(60);
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

  useEffect(() => {
    if (source !== 'live') return;
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [source]);

  const live = source === 'live';
  const store = live ? engine.live : loaded;
  let data: LabData | null = null;
  if (store && store.length >= 32) {
    const to = store.length;
    const from = live && span > 0 ? store.lowerBound(store.tEnd - span) : 0;
    data = { store, from, to, live, tick };
  }
  const usesData = section !== 'auto';

  return (
    <div className="view">
      <header className="view-head">
        <h1>{t('nav.lab')}</h1>
        <div className="seg" role="group" aria-label={t('lab.sections')}>
          {SECTIONS.map((s) => (
            <button key={s} className={section === s ? 'on' : ''} aria-pressed={section === s} onClick={() => set('labSection', s)}>
              {t(`lab.sec.${s}`)}
            </button>
          ))}
        </div>
        <div className="grow" />
        {usesData && (
          <>
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
          </>
        )}
      </header>

      <Helpers />

      {section === 'auto' ? (
        <ScriptConsole />
      ) : !data ? (
        <div className="empty">
          <h2>{t('an.emptyTitle')}</h2>
          <p>{live && snap.status !== 'connected' ? t('an.emptyConnect') : t('an.emptyWait')}</p>
        </div>
      ) : section === 'load' ? (
        <LabLoad data={data} />
      ) : (
        <LabSource data={data} />
      )}
    </div>
  );
}
