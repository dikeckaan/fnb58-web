import { useEffect, useRef, useState } from 'react';
import { runScript, type Cell, type ScriptEvent, type ScriptResult } from '../core/script';
import { useT } from '../i18n';
import { SCRIPT_EXAMPLES } from '../scriptExamples';
import { scriptHost } from '../state/scriptHost';
import { useSettings } from '../state/settings';

const MAX_EVENTS = 2000;
const API = ['read', 'mean', 'sleep', 'waitFor', 'trigger', 'release', 'record', 'reset', 'counters', 'log', 'row', 'check', 'near'] as const;
const SIGNATURES: Record<(typeof API)[number], string> = {
  read: 'read()',
  mean: 'await mean(seconds = 1)',
  sleep: 'await sleep(seconds)',
  waitFor: 'await waitFor(r => test, timeout = 10)',
  trigger: "await trigger('qc2', volts)",
  release: 'await release()',
  record: 'record.start() / record.stop()',
  reset: 'reset()',
  counters: 'counters()',
  log: 'log(...values)',
  row: 'row(...cells)',
  check: 'check(condition, label)',
  near: 'near(value, target, tolerance, label)',
};

const csvCell = (c: Cell) => {
  const s = c === null ? '' : String(c);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function ScriptConsole() {
  const t = useT();
  const lang = useSettings((s) => s.lang);
  const stored = useSettings((s) => s.script);
  const set = useSettings((s) => s.set);
  const code = stored || SCRIPT_EXAMPLES[0].code[lang];
  const [events, setEvents] = useState<ScriptEvent[]>([]);
  const [result, setResult] = useState<ScriptResult | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const out = useRef<HTMLOListElement>(null);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const el = out.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  const run = async () => {
    const ac = new AbortController();
    abort.current = ac;
    setEvents([]);
    setResult(null);
    setCopied(false);
    setRunning(true);
    const r = await runScript(code, scriptHost, (e) => setEvents((prev) => (prev.length >= MAX_EVENTS ? prev : [...prev, e])), ac.signal);
    if (abort.current === ac) {
      setResult(r);
      setRunning(false);
    }
  };

  const rows = events.filter((e) => e.kind === 'row').map((e) => e.cells ?? []);
  const lines = events.filter((e) => e.kind !== 'row');
  const header = rows.length > 1 && rows[0].every((c) => typeof c === 'string') ? rows[0] : null;
  const body = header ? rows.slice(1) : rows;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rows.map((r) => r.map(csvCell).join(',')).join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="analysis-grid">
      <div className="panel">
        <div className="panel-head">
          <h2>{t('scr.title')}</h2>
          <div className="grow" />
          <label className="inline-select">
            <span>{t('scr.example')}</span>
            <select
              value=""
              onChange={(e) => {
                const ex = SCRIPT_EXAMPLES.find((x) => x.id === e.target.value);
                if (ex) set('script', ex.code[lang]);
              }}
            >
              <option value="" disabled>{t('scr.pick')}</option>
              {SCRIPT_EXAMPLES.map((x) => <option key={x.id} value={x.id}>{x.title[lang]}</option>)}
            </select>
          </label>
        </div>
        <p className="muted">{t('scr.intro')}</p>
        <textarea
          className="code" value={code} spellCheck={false} rows={18} aria-label={t('scr.title')} disabled={running}
          onChange={(e) => set('script', e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !running) void run();
          }}
        />
        <div className="actions">
          {running ? (
            <button className="btn danger" onClick={() => abort.current?.abort()}>{t('scr.stop')}</button>
          ) : (
            <button className="btn accent" onClick={() => void run()}>{t('scr.run')}</button>
          )}
          <span className="muted">{running ? t('scr.running') : t('scr.runHint')}</span>
        </div>
        <details className="api">
          <summary>{t('scr.api')}</summary>
          <dl>
            {API.map((k) => (
              <div key={k}>
                <dt className="code-text">{SIGNATURES[k]}</dt>
                <dd>{t(`scr.api.${k}`)}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>{t('scr.output')}</h2></div>
        {result && (
          <div className={`result ${result.verdict === 'pass' ? 'ok' : result.verdict === 'fail' || result.verdict === 'error' ? 'fail' : 'released'}`} role="status">
            <div className="result-big text">{t(`scr.verdict.${result.verdict}`)}</div>
            {result.checks > 0 && <div>{t('scr.checks', { ok: result.checks - result.failed, n: result.checks })}</div>}
            {result.error && <div className="code-text">{result.error}</div>}
          </div>
        )}
        {lines.length ? (
          <ol className="script-out" ref={out}>
            {lines.map((e, k) => (
              <li key={k} className={e.kind}>
                {e.kind !== 'log' && <span className="tag">{t(`scr.tag.${e.kind}`)}</span>}
                <span>{e.text}</span>
              </li>
            ))}
          </ol>
        ) : <p className="muted">{running ? t('scr.running') : t('scr.empty')}</p>}
        {rows.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="stats">
                {header && <thead><tr>{header.map((c, k) => <th key={k}>{String(c)}</th>)}</tr></thead>}
                <tbody>
                  {body.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{c === null ? '' : String(c)}</td>)}</tr>)}
                </tbody>
              </table>
            </div>
            <div className="actions">
              <button className="btn ghost small" onClick={() => void copy()}>{t('scr.copy')}</button>
              {copied && <span className="muted" role="status">{t('scr.copied')}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
