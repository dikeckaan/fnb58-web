import { Download, FileUp, Image, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analyze, type Analysis } from '../core/analysis';
import { csvParts, downloadBlob, parseCsv, safeFilename } from '../core/exporters';
import type { Sample, SampleStore } from '../core/sampleStore';
import { deleteSession, describeStore, listSessions, loadSession, saveSession, updateSession, type SessionMeta } from '../core/sessions';
import { integrate } from '../core/stats';
import { charge, clock, dateTime, energy, num } from '../format';
import { useT } from '../i18n';
import { lastSavedId, libraryChanged, onLibraryChange } from '../state/connection';
import { useSettings } from '../state/settings';
import { LANE_IDS, LANES, type LaneId } from '../theme';
import { Card, Key, Num, Stat } from './common';
import { ScopeGroup, type ScopeHandle } from './ScopeGroup';

function StaticReadout({ lane, a, hover }: { lane: LaneId; a: Analysis; hover: Sample | null }) {
  const t = useT();
  const spec = LANES[lane];
  if (lane === 'd') {
    return (
      <>
        <div className="ro-name">{t('ch.d')}</div>
        <div className="ro-pair"><Key channel="dp" /><span className="ro-tag">D+</span><Num>{num(hover?.dp, 3)}</Num><span className="ro-unit">V</span></div>
        <div className="ro-pair"><Key channel="dn" dash /><span className="ro-tag">D−</span><Num>{num(hover?.dn, 3)}</Num><span className="ro-unit">V</span></div>
      </>
    );
  }
  const st = a[lane];
  const value = hover ? (lane === 'p' ? hover.v * hover.i : hover[lane]) : st.mean;
  return (
    <>
      <div className="ro-name"><Key channel={lane} />{t(`ch.${lane}`)}</div>
      <div className="ro-value small"><Num>{num(value, spec.digits)}</Num><span className="ro-unit">{spec.unit}</span></div>
      <div className="ro-range">{hover ? t('ro.atCursor') : t('ro.mean')}</div>
    </>
  );
}

function Detail({ meta, store, all, onDeleted }: { meta: SessionMeta; store: SampleStore; all: SessionMeta[]; onDeleted(): void }) {
  const t = useT();
  const lang = useSettings((s) => s.lang);
  const efficiency = useSettings((s) => s.efficiency);
  const price = useSettings((s) => s.price);
  const currency = useSettings((s) => s.currency);
  const [name, setName] = useState(meta.name);
  const [note, setNote] = useState(meta.note);
  const [compareId, setCompareId] = useState('');
  const [overlay, setOverlay] = useState<SampleStore | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lanes, setLanes] = useState<LaneId[]>(['v', 'i', 'p']);
  const scope = useRef<ScopeHandle | null>(null);
  const a = useMemo(() => analyze(store), [store]);
  const other = useMemo(() => (overlay ? integrate(overlay) : null), [overlay]);

  useEffect(() => {
    setName(meta.name);
    setNote(meta.note);
    setCompareId('');
    setOverlay(null);
    setConfirmDelete(false);
  }, [meta.id, meta.name, meta.note]);

  useEffect(() => {
    let alive = true;
    if (!compareId) return setOverlay(null);
    void loadSession(compareId).then((s) => alive && setOverlay(s));
    return () => {
      alive = false;
    };
  }, [compareId]);

  const commit = async (patch: { name?: string; note?: string }) => {
    await updateSession(meta.id, patch);
    libraryChanged();
  };

  const file = safeFilename(meta.name);
  const exportCsv = () => downloadBlob(csvParts(store), `${file}.csv`, 'text/csv');
  const exportJson = () =>
    downloadBlob(
      [JSON.stringify({
        format: 'fnb58-bench/1', meta, analysis: a,
        columns: {
          t: Array.from(store.t.subarray(0, store.length)),
          v: Array.from(store.v.subarray(0, store.length)),
          i: Array.from(store.i.subarray(0, store.length)),
          dp: Array.from(store.dp.subarray(0, store.length)),
          dn: Array.from(store.dn.subarray(0, store.length)),
          temp: Array.from(store.temp.subarray(0, store.length)),
        },
      })],
      `${file}.json`, 'application/json',
    );
  const exportPng = () => {
    const url = scope.current?.toPng();
    if (!url) return;
    const link = document.createElement('a');
    link.href = url;
    link.download = `${file}.png`;
    link.click();
  };

  const cap = charge(a.ah);
  const en = energy(a.wh);
  const cost = (a.wh / 1000) * price;
  const toggle = (id: LaneId) =>
    setLanes((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      return next.length ? LANE_IDS.filter((x) => next.includes(x)) : cur;
    });

  return (
    <div className="detail">
      <div className="detail-head">
        <input
          className="title-input"
          value={name}
          aria-label={t('lib.name')}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== meta.name && void commit({ name: name.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <div className="detail-meta">
          {dateTime(meta.createdAt, lang)}, {meta.device}, {t('lib.rate', { n: meta.rate })}, {t('lib.samples', { n: meta.samples.toLocaleString(lang) })}
          {meta.source === 'imported' && `, ${t('lib.imported')}`}
        </div>
      </div>

      <div className="cards">
        <Card title={t('an.duration')}><Stat value={clock(a.duration)} /></Card>
        <Card title={t('card.capacity')}><Stat value={cap.value} unit={cap.unit} /></Card>
        <Card title={t('card.energy')}><Stat value={en.value} unit={en.unit} note={t('an.cost', { v: cost.toFixed(4), c: currency })} /></Card>
        <Card title={t('an.cell')}>
          <Stat value={num(a.mah37 * efficiency, 0)} unit="mAh" note={t('an.cellNote', { e: Math.round(efficiency * 100) })} />
        </Card>
        <Card title={t('an.voltage')}>
          <Stat value={num(a.v.mean, 3)} unit="V" note={t('ro.minmax', { min: num(a.v.min, 3), max: num(a.v.max, 3) })} />
        </Card>
        <Card title={t('an.current')}>
          <Stat value={num(a.i.mean, 3)} unit="A" note={t('an.peak', { v: num(a.i.max, 3), u: 'A' })} />
        </Card>
        <Card title={t('an.power')}>
          <Stat value={num(a.p.mean, 2)} unit="W" note={t('an.peakAt', { v: num(a.p.max, 2), u: 'W', t: clock(a.peakPowerAt) })} />
        </Card>
        <Card title={t('an.temp')}>
          <Stat value={num(a.temp.max, 1)} unit="°C" note={t('an.tempRise', { v: num(a.temp.max - a.temp.min, 1) })} />
        </Card>
        <Card title={t('an.taper')}>
          <Stat value={a.taperAt === null ? '–' : clock(a.taperAt)} note={a.taperAt === null ? t('an.noTaper') : t('an.taperNote')} />
        </Card>
        <Card title={t('an.t80')}>
          <Stat value={a.t80 === null ? '–' : clock(a.t80)} note={t('an.t80Note')} />
        </Card>
      </div>

      <ScopeGroup
        store={store}
        live={false}
        lanes={lanes}
        overlay={overlay}
        handleRef={scope}
        readout={(lane, hover) => <StaticReadout lane={lane} a={a} hover={hover} />}
        toolbar={
          <>
            <div className="chips" role="group" aria-label={t('scope.lanes')}>
              {LANE_IDS.map((id) => (
                <button key={id} className={`chip${lanes.includes(id) ? ' on' : ''}`} aria-pressed={lanes.includes(id)} onClick={() => toggle(id)}>
                  <Key channel={id === 'd' ? 'dp' : id} />{t(`ch.${id}.short`)}
                </button>
              ))}
            </div>
            <label className="inline-select">
              <span>{t('lib.compare')}</span>
              <select value={compareId} onChange={(e) => setCompareId(e.target.value)}>
                <option value="">{t('lib.compareNone')}</option>
                {all.filter((m) => m.id !== meta.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
          </>
        }
      />

      {overlay && other && (
        <div className="notice">
          {t('lib.compareNote', {
            a: `${energy(a.wh).value} ${energy(a.wh).unit}`,
            b: `${energy(other.wh).value} ${energy(other.wh).unit}`,
            d: `${a.wh >= other.wh ? '+' : '−'}${Math.abs(other.wh ? ((a.wh - other.wh) / other.wh) * 100 : 0).toFixed(1)} %`,
          })}
        </div>
      )}

      <label className="field">
        <span className="field-label">{t('lib.note')}</span>
        <textarea
          rows={2}
          value={note}
          placeholder={t('lib.notePlaceholder')}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note !== meta.note && void commit({ note })}
        />
      </label>

      <div className="actions">
        <button className="btn ghost" onClick={exportCsv}><Download size={16} aria-hidden="true" />{t('lib.csv')}</button>
        <button className="btn ghost" onClick={exportJson}><Download size={16} aria-hidden="true" />{t('lib.json')}</button>
        <button className="btn ghost" onClick={exportPng}><Image size={16} aria-hidden="true" />{t('lib.png')}</button>
        <div className="grow" />
        {confirmDelete ? (
          <>
            <button className="btn ghost" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button>
            <button
              className="btn danger"
              onClick={async () => {
                await deleteSession(meta.id);
                libraryChanged();
                onDeleted();
              }}
            >
              {t('lib.deleteConfirm')}
            </button>
          </>
        ) : (
          <button className="btn ghost" onClick={() => setConfirmDelete(true)}><Trash2 size={16} aria-hidden="true" />{t('lib.delete')}</button>
        )}
      </div>
    </div>
  );
}

export function RecordingsView() {
  const t = useT();
  const lang = useSettings((s) => s.lang);
  const [list, setList] = useState<SessionMeta[] | null>(null);
  const [selected, setSelected] = useState<string | null>(lastSavedId);
  const [store, setStore] = useState<SampleStore | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    listSessions().then(setList).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refresh();
    return onLibraryChange(refresh);
  }, [refresh]);

  useEffect(() => {
    if (list && list.length && !list.some((m) => m.id === selected)) setSelected(list[0].id);
    if (list && !list.length) setSelected(null);
  }, [list, selected]);

  useEffect(() => {
    let alive = true;
    setStore(null);
    if (selected) void loadSession(selected).then((s) => alive && setStore(s));
    return () => {
      alive = false;
    };
  }, [selected]);

  const onImport = async (files: FileList | null) => {
    setError('');
    for (const f of Array.from(files ?? [])) {
      try {
        const text = await f.text();
        let s: SampleStore;
        let name = f.name.replace(/\.(csv|json|txt)$/i, '');
        if (/^\s*\{/.test(text)) {
          const j = JSON.parse(text) as { meta?: { name?: string }; columns: Record<string, number[]> };
          const c = j.columns;
          const rows = c.t.map((tt, k) => `${tt},${c.v[k]},${c.i[k]},${c.dp?.[k] ?? 0},${c.dn?.[k] ?? 0},${c.temp?.[k] ?? 0}`);
          s = parseCsv(['time_s,voltage_V,current_A,dplus_V,dminus_V,temp_C', ...rows].join('\n'));
          name = j.meta?.name ?? name;
        } else {
          s = parseCsv(text);
        }
        const { ah, wh } = integrate(s);
        const rate = s.length > 1 ? Math.round((s.length - 1) / s.duration) : 0;
        const meta = describeStore(s, { name, createdAt: f.lastModified || Date.now(), device: 'CSV', rate, ah, wh, source: 'imported' });
        await saveSession(meta, s);
        setSelected(meta.id);
      } catch (e) {
        const code = e instanceof Error ? e.message : '';
        setError(t('lib.importFailed', { name: f.name, why: t(code === 'columns' ? 'lib.errColumns' : 'lib.errRows') }));
      }
    }
    libraryChanged();
    if (fileRef.current) fileRef.current.value = '';
  };

  const meta = list?.find((m) => m.id === selected) ?? null;

  return (
    <div className="view">
      <header className="view-head">
        <h1>{t('nav.recordings')}</h1>
        <div className="grow" />
        <input ref={fileRef} type="file" accept=".csv,.json,.txt,text/csv,application/json" multiple hidden onChange={(e) => void onImport(e.target.files)} />
        <button className="btn ghost" onClick={() => fileRef.current?.click()}><FileUp size={16} aria-hidden="true" />{t('lib.import')}</button>
      </header>
      {error && <div className="notice warn" role="alert">{error}</div>}

      {list && list.length === 0 ? (
        <div className="empty">
          <h2>{t('lib.emptyTitle')}</h2>
          <p>{t('lib.emptyBody')}</p>
        </div>
      ) : (
        <div className="library">
          <ul className="session-list" aria-label={t('nav.recordings')}>
            {(list ?? []).map((m) => {
              const c = charge(m.ah);
              const e = energy(m.wh);
              return (
                <li key={m.id}>
                  <button className={`session${m.id === selected ? ' active' : ''}`} aria-current={m.id === selected} onClick={() => setSelected(m.id)}>
                    <span className="session-name">{m.name}</span>
                    <span className="session-meta">{dateTime(m.createdAt, lang)}</span>
                    <span className="session-nums"><span>{clock(m.duration)}</span><span>{c.value} {c.unit}</span><span>{e.value} {e.unit}</span></span>
                  </button>
                </li>
              );
            })}
          </ul>
          {meta && store ? (
            <Detail meta={meta} store={store} all={list ?? []} onDeleted={() => setSelected(null)} />
          ) : (
            <div className="detail"><p className="muted">{selected ? t('common.loading') : ''}</p></div>
          )}
        </div>
      )}
    </div>
  );
}
