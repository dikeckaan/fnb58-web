// Guess the charging signature from the data-line voltages.
// D+/D- only reveal the legacy schemes. USB Power Delivery negotiates on the CC
// pins, which this meter does not report over USB, so PD is inferred from VBUS.

export type GuessId =
  | 'none' | 'idle' | 'sdp' | 'dcp' | 'apple05' | 'apple1' | 'apple21' | 'apple24' | 'samsung2'
  | 'qc2_5' | 'qc2_9' | 'qc2_12' | 'qc2_20' | 'qc3' | 'pd' | 'afcfcp' | 'unknown';

export interface Guess {
  id: GuessId;
  /** 0..1, how specific the evidence is. */
  confidence: number;
}

const near = (x: number, target: number, tol: number) => Math.abs(x - target) <= tol;

export function guessProtocol(v: number, dp: number, dn: number): Guess {
  if (v < 3) return { id: 'none', confidence: 1 };

  const p06 = near(dp, 0.6, 0.2);
  const n06 = near(dn, 0.6, 0.2);
  const p33 = near(dp, 3.3, 0.35);
  const n33 = near(dn, 3.3, 0.35);
  const p0 = dp < 0.25;
  const n0 = dn < 0.25;
  const elevated = v > 5.6;

  // Quick Charge 2.0 class A/B states.
  if (p33 && n06) return { id: 'qc2_9', confidence: near(v, 9, 0.8) ? 0.9 : 0.6 };
  if (p06 && n06 && near(v, 12, 0.9)) return { id: 'qc2_12', confidence: 0.85 };
  if (p33 && n33) return { id: 'qc2_20', confidence: near(v, 20, 1.2) ? 0.9 : 0.55 };
  if (p06 && n33) return { id: 'qc3', confidence: 0.8 };

  // Apple resistor dividers.
  const p20 = near(dp, 2.0, 0.2);
  const n20 = near(dn, 2.0, 0.2);
  const p27 = near(dp, 2.7, 0.2);
  const n27 = near(dn, 2.7, 0.2);
  if (p27 && n27) return { id: 'apple24', confidence: 0.85 };
  if (p27 && n20) return { id: 'apple21', confidence: 0.85 };
  if (p20 && n27) return { id: 'apple1', confidence: 0.85 };
  if (p20 && n20) return { id: 'apple05', confidence: 0.85 };

  if (near(dp, 1.2, 0.15) && near(dn, 1.2, 0.15)) return { id: 'samsung2', confidence: 0.8 };

  if (elevated && p0 && n0) return { id: 'pd', confidence: 0.6 };
  if (elevated && p06 && n0) return { id: 'afcfcp', confidence: 0.5 };
  if (p06 && n0) return { id: 'qc2_5', confidence: 0.45 };
  if (p06 && n06) return { id: 'dcp', confidence: 0.55 };
  if (p0 && n0) return { id: 'idle', confidence: 0.5 };
  if (!elevated && dp > 2.4 && dn < 0.4) return { id: 'sdp', confidence: 0.4 };
  return { id: 'unknown', confidence: 0.2 };
}

/** Majority vote over recent guesses so the label does not flicker during negotiation. */
export class GuessSmoother {
  private readonly window: GuessId[] = [];
  constructor(private readonly size = 12) {}

  push(g: Guess): GuessId {
    this.window.push(g.id);
    if (this.window.length > this.size) this.window.shift();
    const counts = new Map<GuessId, number>();
    let best: GuessId = g.id;
    let bestN = 0;
    for (const id of this.window) {
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      if (n > bestN) {
        bestN = n;
        best = id;
      }
    }
    return best;
  }

  reset(): void {
    this.window.length = 0;
  }
}
