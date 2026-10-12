import { useEffect } from 'react';
import { AnalysisView } from './components/AnalysisView';
import { FloatingMeter } from './components/FloatingMeter';
import { LabView } from './components/LabView';
import { LiveView } from './components/LiveView';
import { RecordingsView } from './components/RecordingsView';
import { SettingsView } from './components/SettingsView';
import { Sidebar } from './components/Sidebar';
import { ToolsView } from './components/ToolsView';
import { TriggerView } from './components/TriggerView';
import { engine } from './core/engine';
import { useSettings, type Tab } from './state/settings';

const ORDER: Tab[] = ['live', 'analysis', 'lab', 'recordings', 'trigger', 'tools', 'settings'];

export function App() {
  const tab = useSettings((s) => s.tab);
  const lang = useSettings((s) => s.lang);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = lang === 'tr' ? 'FNB58 Tezgâh' : 'FNB58 Bench';
  }, [lang]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (e.key >= '1' && e.key <= String(ORDER.length)) {
        useSettings.getState().set('tab', ORDER[Number(e.key) - 1]);
      } else if (e.key === 'r' || e.key === 'R') {
        if (engine.getSnapshot().rec.state === 'idle') engine.startRecording(useSettings.getState().record);
        else engine.stopRecording();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {tab === 'live' && <LiveView />}
        {tab === 'analysis' && <AnalysisView />}
        {tab === 'lab' && <LabView />}
        {tab === 'recordings' && <RecordingsView />}
        {tab === 'trigger' && <TriggerView />}
        {tab === 'tools' && <ToolsView />}
        {tab === 'settings' && <SettingsView />}
      </main>
      <FloatingMeter />
    </div>
  );
}
