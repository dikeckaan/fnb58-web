import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_ALARMS, DEFAULT_RECORD, type AlarmConfig, type RecordConfig } from '../core/engine';
import type { BatteryInput, Fingerprint } from '../core/lab';
import type { Step } from '../core/sequence';
import type { Scenario } from '../device/simulator';
import { LANE_IDS, type LaneId } from '../theme';

export type Lang = 'tr' | 'en';
export type Tab = 'live' | 'analysis' | 'lab' | 'recordings' | 'trigger' | 'tools' | 'settings';
export type LabSection = 'load' | 'source' | 'auto';

export interface SavedFingerprint {
  id: string;
  name: string;
  /** Wall-clock milliseconds. */
  at: number;
  fp: Fingerprint;
}

export interface Settings {
  lang: Lang;
  tab: Tab;
  /** Seconds shown by the live scope. */
  windowS: number;
  lanes: LaneId[];
  alarms: AlarmConfig;
  record: RecordConfig;
  sound: boolean;
  autoReconnect: boolean;
  scenario: Scenario;
  /** Currency per kWh, for the cost tool. */
  price: number;
  currency: string;
  /** Efficiency assumed when converting energy to cell capacity, 0..1. */
  efficiency: number;
  /** The user has read and accepted the trigger warning. */
  triggerAccepted: boolean;
  plan: Step[];
  planLoop: boolean;
  labSection: LabSection;
  battery: BatteryInput;
  /** Charge termination current in mA, for the forecast. */
  cutoffMa: number;
  fingerprints: SavedFingerprint[];
  /** Last script in the automation console; empty means the first example. */
  script: string;
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
  toggleLane(id: LaneId): void;
}

const browserLang = (): Lang =>
  typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('en') ? 'en' : 'tr';

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      lang: browserLang(),
      tab: 'live',
      windowS: 60,
      lanes: [...LANE_IDS],
      alarms: structuredClone(DEFAULT_ALARMS),
      record: { ...DEFAULT_RECORD },
      sound: true,
      autoReconnect: true,
      scenario: 'phone',
      price: 2.6,
      currency: '₺',
      efficiency: 0.9,
      triggerAccepted: false,
      plan: [],
      planLoop: false,
      labSection: 'load',
      battery: { capacityMah: 2000, usable: 0.85, selfDischargePct: 2 },
      cutoffMa: 100,
      fingerprints: [],
      script: '',
      set: (key, value) => set({ [key]: value } as Partial<Settings>),
      toggleLane: (id) =>
        set((s) => {
          const on = s.lanes.includes(id);
          if (on && s.lanes.length === 1) return s; // always keep one lane
          const next = on ? s.lanes.filter((x) => x !== id) : [...s.lanes, id];
          return { lanes: LANE_IDS.filter((x) => next.includes(x)) };
        }),
    }),
    {
      name: 'fnb58-bench-settings',
      version: 1,
      partialize: ({ set: _s, toggleLane: _t, tab: _tab, ...rest }) => rest,
    },
  ),
);
