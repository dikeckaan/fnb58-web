import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DICT, translate } from './i18n';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

// Values each template variable can take, so `ch.${id}` style keys are checked too.
const EXPAND: Record<string, string[]> = {
  'alarm.${e.detail}': ['vHigh', 'vLow', 'iHigh', 'pHigh', 'tHigh'].map((k) => `alarm.${k}`),
  'alarm.${k}': ['vHigh', 'vLow', 'iHigh', 'pHigh', 'tHigh'].map((k) => `alarm.${k}`),
  'alarm.${k}.now': ['vHigh', 'vLow', 'iHigh', 'pHigh', 'tHigh'].map((k) => `alarm.${k}.now`),
  'alarm.${k}.rule': ['vHigh', 'vLow', 'iHigh', 'pHigh', 'tHigh'].map((k) => `alarm.${k}.rule`),
  'ch.${c}': ['v', 'i', 'p'].map((k) => `ch.${k}`),
  'ch.${focus}': ['v', 'i', 'p'].map((k) => `ch.${k}`),
  'ch.${id}': ['v', 'i', 'p', 'd', 'temp'].map((k) => `ch.${k}`),
  'ch.${lane}': ['v', 'i', 'p', 'd', 'temp'].map((k) => `ch.${k}`),
  'ch.${id}.short': ['v', 'i', 'p', 'd', 'temp'].map((k) => `ch.${k}.short`),
  'chx.${c}': ['v', 'i', 'p', 'dp', 'dn', 'temp'].map((k) => `chx.${k}`),
  'lane.${id}': ['v', 'i', 'p', 'd', 'temp'].map((k) => `lane.${k}`),
  'nav.${id}': ['live', 'analysis', 'lab', 'recordings', 'trigger', 'tools', 'settings'].map((k) => `nav.${k}`),
  'sim.${scenario}': ['phone', 'laptop', 'powerbank', 'iot', 'idle'].map((k) => `sim.${k}`),
  'sim.${x}': ['phone', 'laptop', 'powerbank', 'iot', 'idle'].map((k) => `sim.${k}`),
  'log.${e.kind}': ['connect', 'disconnect', 'trigger', 'triggerFail', 'release', 'alarm', 'recStart', 'recStop', 'gap', 'error'].map((k) => `log.${k}`),
  'guess.${snap.guess}': ['none', 'idle', 'sdp', 'dcp', 'apple05', 'apple1', 'apple21', 'apple24', 'samsung2', 'qc2_5', 'qc2_9', 'qc2_12', 'qc2_20', 'qc3', 'pd', 'afcfcp', 'unknown'].map((k) => `guess.${k}`),
  'guess.${s.id}': ['dcp', 'apple05', 'apple1', 'apple21', 'apple24', 'samsung2', 'qc2_5', 'qc2_9', 'qc2_12', 'qc2_20', 'qc3', 'pd'].map((k) => `guess.${k}`),
  'sig.${s.id}': ['dcp', 'apple05', 'apple1', 'apple21', 'apple24', 'samsung2', 'qc2_5', 'qc2_9', 'qc2_12', 'qc2_20', 'qc3', 'pd'].map((k) => `sig.${k}`),
  'guess.${f.guess}': ['none', 'idle', 'sdp', 'dcp', 'apple05', 'apple1', 'apple21', 'apple24', 'samsung2', 'qc2_5', 'qc2_9', 'qc2_12', 'qc2_20', 'qc3', 'pd', 'afcfcp', 'unknown'].map((k) => `guess.${k}`),
  'lab.sec.${s}': ['load', 'source', 'auto'].map((k) => `lab.sec.${k}`),
  'cell.${c.id}': ['cr2032', 'aaa', 'aa', '18650', 'lipo'].map((k) => `cell.${k}`),
  'chg.phase.${f.phase}': ['idle', 'cc', 'cv', 'done'].map((k) => `chg.phase.${k}`),
  'fp.trait.${id}': ['level', 'rs', 'ripple', 'line', 'dp', 'dn', 'guess'].map((k) => `fp.trait.${k}`),
  'allan.kind.${kind}': ['periodic', 'white', 'flicker', 'drift'].map((k) => `allan.kind.${k}`),
  'scr.api.${k}': ['read', 'mean', 'sleep', 'waitFor', 'trigger', 'release', 'record', 'reset', 'counters', 'log', 'row', 'check', 'near'].map((k) => `scr.api.${k}`),
  'scr.verdict.${result.verdict}': ['pass', 'fail', 'none', 'error', 'stopped'].map((k) => `scr.verdict.${k}`),
  'scr.tag.${e.kind}': ['pass', 'fail', 'error'].map((k) => `scr.tag.${k}`),
};

describe('translations', () => {
  it('has a string for every key the interface asks for', () => {
    const used = new Set<string>();
    const unknownTemplates: string[] = [];
    for (const file of sources(dirname(fileURLToPath(import.meta.url)))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*(['`])([^'`]+)\1/g)) {
        const key = m[2];
        if (key.includes('${')) {
          if (EXPAND[key]) EXPAND[key].forEach((k) => used.add(k));
          else unknownTemplates.push(`${file}: ${key}`);
        } else used.add(key);
      }
      // Keys chosen by a ternary inside t(...).
      for (const m of text.matchAll(/'((?:cable|level|lib|duty|fp|gad|allan)\.[a-zA-Z0-9]+)'/g)) used.add(m[1]);
    }
    expect(unknownTemplates).toEqual([]);
    const missing = [...used].filter((k) => !(k in DICT.tr));
    expect(missing).toEqual([]);
  });

  it('keeps placeholders identical in both languages', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const bad = Object.keys(DICT.tr).filter((k) => vars(DICT.tr[k as keyof typeof DICT.tr]) !== vars(DICT.en[k as keyof typeof DICT.en]));
    expect(bad).toEqual([]);
  });

  it('fills placeholders and falls back to the key', () => {
    expect(translate('en', 'dev.rate', { n: 100 })).toBe('100 samples/s');
    expect(translate('tr', 'dev.rate', { n: 100 })).toBe('100 örnek/sn');
    expect(translate('tr', 'no.such.key')).toBe('no.such.key');
  });
});
