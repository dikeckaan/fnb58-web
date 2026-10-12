import { useSyncExternalStore } from 'react';
import { engine, type Snapshot } from '../core/engine';

export function useEngine(): Snapshot {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot);
}
