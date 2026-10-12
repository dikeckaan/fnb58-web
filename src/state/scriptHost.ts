// Connects the script runner to the live engine and the user's settings.

import { engine } from '../core/engine';
import type { ScriptHost } from '../core/script';
import { snapTrigger, TRIGGER_PROTOCOLS } from '../device/protocol';
import { translate } from '../i18n';
import { useSettings } from './settings';

const text = (key: string, vars?: Record<string, string | number>) => translate(useSettings.getState().lang, key, vars);

export const scriptHost: ScriptHost = {
  read() {
    const s = engine.live;
    const n = s.length;
    if (!n || !engine.connected) return null;
    const k = n - 1;
    return { t: s.t[k], v: s.v[k], i: s.i[k], p: s.p[k], dp: s.dp[k], dn: s.dn[k], temp: s.temp[k] };
  },

  mean(seconds) {
    const s = engine.live;
    const n = s.length;
    if (!n || !engine.connected) return null;
    const from = Math.min(n - 1, s.lowerBound(s.tEnd - Math.max(0.01, seconds)));
    const sum = { v: 0, i: 0, p: 0, dp: 0, dn: 0, temp: 0 };
    let vMin = Infinity;
    let vMax = -Infinity;
    let iMin = Infinity;
    let iMax = -Infinity;
    for (let k = from; k < n; k++) {
      sum.v += s.v[k];
      sum.i += s.i[k];
      sum.p += s.p[k];
      sum.dp += s.dp[k];
      sum.dn += s.dn[k];
      sum.temp += s.temp[k];
      if (s.v[k] < vMin) vMin = s.v[k];
      if (s.v[k] > vMax) vMax = s.v[k];
      if (s.i[k] < iMin) iMin = s.i[k];
      if (s.i[k] > iMax) iMax = s.i[k];
    }
    const c = n - from;
    return {
      t: s.tEnd, v: sum.v / c, i: sum.i / c, p: sum.p / c, dp: sum.dp / c, dn: sum.dn / c, temp: sum.temp / c,
      vpp: vMax - vMin, ipp: iMax - iMin, samples: c,
    };
  },

  async trigger(protocol, volts) {
    // The same consent as the Trigger page: a script must not raise VBUS behind the user's back.
    if (!useSettings.getState().triggerAccepted) throw new Error(text('scr.needConsent'));
    const want = protocol.toLowerCase().replace(/[^a-z0-9]/g, '');
    const p = TRIGGER_PROTOCOLS.find((x) => x.id === want || x.name.toLowerCase().replace(/[^a-z0-9]/g, '') === want);
    if (!p) throw new Error(text('scr.badProtocol', { name: protocol, list: TRIGGER_PROTOCOLS.map((x) => x.id).join(', ') }));
    if (!Number.isFinite(volts)) throw new Error(text('scr.badVolts'));
    return engine.trigger(p, snapTrigger(p, Math.round(volts * 1000)));
  },

  release: () => engine.release(),
  startRecording: () => engine.startRecording(useSettings.getState().record),
  stopRecording: () => void engine.stopRecording(),
  resetCounters: () => engine.resetCounters(),
  counters() {
    const s = engine.getSnapshot();
    return { ah: s.ah, wh: s.wh, elapsed: s.elapsed };
  },
};
