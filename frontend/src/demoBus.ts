// Demo bus (§I.2) — a tiny module-scope store bridging the choreographed Demo
// stage and the map. DemoStage WRITES it (setDemoBus/resetDemoBus); MapView's
// DemoLayer READS it (useDemoBus). Neither module imports the other, so the
// stage stays crash-isolated from the console — a throw inside DemoStage can
// never take MapView down with it, and the bus is the only shared surface.
//
// State is presentation-only: routes/pickup here describe the routing NARRATIVE
// drawn over the tiles (see theme.ts routeVia — the backend has no depot). The
// snapshot object is replaced (never mutated in place) on every write so
// useSyncExternalStore sees a stable reference between changes.

import { useSyncExternalStore } from 'react';

/** A single arc drawn over the map. `store-leg1` = pickup→warehouse (solid),
 *  `store-leg2` = warehouse→recipient (dashed); `direct` = pickup→recipient. */
export interface DemoRoute {
  id: string;
  kind: 'direct' | 'store-leg1' | 'store-leg2';
  from: [number, number];
  to: [number, number];
}

export interface DemoBus {
  active: boolean;
  pickup?: { lat: number; lng: number; label: string };
  routes: DemoRoute[];
  focusRecipientIds: string[];
  /** A pickup that found no takers — pulsing muted-red ring, no route. */
  failedAtPickup?: boolean;
}

function initial(): DemoBus {
  return { active: false, routes: [], focusRecipientIds: [] };
}

let state: DemoBus = initial();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Subscribe to bus changes; returns an unsubscribe fn (useSyncExternalStore). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current snapshot — stable reference between writes. */
export function getSnapshot(): DemoBus {
  return state;
}

/** Merge a partial into the bus (replaces the snapshot object) and notify. */
export function setDemoBus(partial: Partial<DemoBus>): void {
  state = { ...state, ...partial };
  emit();
}

/** Reset the bus to its idle state (fresh arrays) and notify. */
export function resetDemoBus(): void {
  state = initial();
  emit();
}

/** React hook — re-renders on any bus write. */
export function useDemoBus(): DemoBus {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
