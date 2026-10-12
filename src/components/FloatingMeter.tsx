import { createPortal } from 'react-dom';
import { charge, energy, num } from '../format';
import { useT } from '../i18n';
import { useGadgets } from '../state/gadgets';
import { useEngine } from '../state/useEngine';
import { SERIES } from '../theme';
import { Num } from './common';

/** The always-on-top readout. Renders into the floating window while one is open. */
export function FloatingMeter() {
  const t = useT();
  const snap = useEngine();
  const win = useGadgets((s) => s.floating);
  if (!win || win.closed) return null;
  const now = snap.now;
  const c = charge(snap.ah);
  const e = energy(snap.wh);
  return createPortal(
    <div className="float">
      {now ? (
        <>
          <div className="float-row" style={{ borderColor: SERIES.v }}>
            <Num>{num(now.v, 4)}</Num><span className="float-unit">V</span>
          </div>
          <div className="float-row" style={{ borderColor: SERIES.i }}>
            <Num>{num(now.i, 4)}</Num><span className="float-unit">A</span>
          </div>
          <div className="float-row" style={{ borderColor: SERIES.p }}>
            <Num>{num(now.p, 3)}</Num><span className="float-unit">W</span>
          </div>
          <div className="float-foot">
            <span>{t(`guess.${snap.guess}`)}</span>
            <span className="mono">{c.value} {c.unit}</span>
            <span className="mono">{e.value} {e.unit}</span>
            <span className="mono">{num(now.temp, 1)} °C</span>
          </div>
        </>
      ) : (
        <p className="float-empty">{t('gad.floatEmpty')}</p>
      )}
    </div>,
    win.document.body,
  );
}
