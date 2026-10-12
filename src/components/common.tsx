import type { ReactNode } from 'react';
import { SERIES } from '../theme';
import type { Channel } from '../core/sampleStore';

/** Keeps a number in one inline box so flex gaps never split it. */
export function Num({ children }: { children: string }) {
  return <span className="num">{children}</span>;
}

/** A short stroke in the series colour. Mirrors the line it stands for. */
export function Key({ channel, dash }: { channel: Channel; dash?: boolean }) {
  return <span className={`key${dash ? ' dash' : ''}`} style={{ color: SERIES[channel] }} aria-hidden="true" />;
}

export function Card({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`card${wide ? ' wide' : ''}`}>
      <div className="card-title">{title}</div>
      {children}
    </div>
  );
}

export function Stat({ value, unit, note }: { value: string; unit?: string; note?: string }) {
  return (
    <>
      <div className="stat">
        <Num>{value}</Num>
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {note && <div className="stat-note">{note}</div>}
    </>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

interface NumberInputProps {
  value: number;
  onChange(v: number): void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  'aria-label'?: string;
}

export function NumberInput({ value, onChange, min, max, step, unit, disabled, ...rest }: NumberInputProps) {
  return (
    <span className="num-input">
      <input
        type="number"
        inputMode="decimal"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step ?? 'any'}
        disabled={disabled}
        aria-label={rest['aria-label']}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (Number.isFinite(v)) onChange(v);
        }}
      />
      {unit && <span className="num-unit">{unit}</span>}
    </span>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}
