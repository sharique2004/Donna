// Color logic shared across the console: the score ramp (viridis-ish) used on the
// map and the five term colors used by the stacked score bars + legend.

import type { ItemCategory, ScoreBreakdown, TermKey } from './types';

// Five stacked-bar term colors. Cold = icy cyan, equity = green, etc.
export const TERM_COLORS: Record<TermKey, string> = {
  feasibility: '#ffb454', // amber — time/route
  coldchain: '#4cc9f0',   // ice cyan — refrigeration
  capacity: '#c77dff',    // violet — volume fit
  equity: '#57cc99',      // green — fairness
  prefs: '#ff8fab',       // pink — preferences/history
};

export const TERM_LABELS: Record<TermKey, string> = {
  feasibility: 'Feasibility',
  coldchain: 'Cold-chain',
  capacity: 'Capacity',
  equity: 'Equity',
  prefs: 'Prefs',
};

// Viridis-ish anchors for the recipient score ramp (0 → 1).
const RAMP: Array<[number, [number, number, number]]> = [
  [0.0, [68, 1, 84]],
  [0.25, [59, 82, 139]],
  [0.5, [33, 144, 141]],
  [0.75, [93, 200, 99]],
  [1.0, [253, 231, 37]],
];

const GREY = '#54607a';

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** Viridis-ish color for a 0..1 score. */
export function rampColor(score: number): string {
  const s = Math.max(0, Math.min(1, score));
  for (let i = 1; i < RAMP.length; i++) {
    const [p0, c0] = RAMP[i - 1];
    const [p1, c1] = RAMP[i];
    if (s <= p1) {
      const t = (s - p0) / (p1 - p0 || 1);
      const r = Math.round(lerp(c0[0], c1[0], t));
      const g = Math.round(lerp(c0[1], c1[1], t));
      const b = Math.round(lerp(c0[2], c1[2], t));
      return `rgb(${r},${g},${b})`;
    }
  }
  return '#fde725';
}

/** Pin/marker color for a recipient given its score breakdown. Grey on hard-fail. */
export function scoreColor(score: ScoreBreakdown | undefined): string {
  if (!score) return GREY;
  if (score.hardFail) return GREY;
  return rampColor(score.total);
}

/**
 * Turn a raw enum token into human copy. Used EVERYWHERE a token could reach the
 * screen (categories, infrastructure, outcomes, recipient types, patch values).
 *   fresh_produce  → "fresh produce"
 *   walk_in_fridge → "walk-in fridge"
 *   dry_goods      → "dry goods"
 *   no_answer      → "no answer"
 */
export function humanize(token: unknown): string {
  return String(token ?? '')
    .replace(/walk_in/g, 'walk-in')
    .replace(/_/g, ' ')
    .trim();
}

export const CATEGORY_LABELS: Record<ItemCategory, string> = {
  fresh_produce: 'Fresh produce',
  fruit: 'Fruit',
  canned: 'Canned',
  dry_goods: 'Dry goods',
  baked: 'Baked',
  dairy: 'Dairy',
  meat: 'Meat',
  prepared: 'Prepared',
  beverages: 'Beverages',
  other: 'Other',
};

export const HARDFAIL_LABELS: Record<string, string> = {
  infeasible_time: 'Too far — would spoil',
  no_cold_chain: 'No cold storage',
  category_rejected: 'Category rejected',
};

export function fmtLbs(n: number): string {
  return `${Math.round(n).toLocaleString()} lb`;
}
export function fmtPct(n: number): string {
  return `${Math.round(n * 100)}`;
}
export function fmtMiles(n: number): string {
  return `${n.toFixed(1)} mi`;
}
export function fmtHours(n: number): string {
  if (n < 1) return `${Math.round(n * 60)} min`;
  return `${n.toFixed(1)} h`;
}

/**
 * Live spoilage countdown from a donation's receivedAt + the item's hoursToSpoil.
 * Recomputed on each render (the 3s poll re-renders the feed), so it reads as a
 * ticking clock during the demo. Clamped at zero → "spoiled".
 */
export function spoilCountdown(receivedAt: string, hoursToSpoil: number): string {
  const deadline = new Date(receivedAt).getTime() + hoursToSpoil * 3600_000;
  const msLeft = deadline - Date.now();
  if (msLeft <= 0) return 'spoiled';
  const hLeft = msLeft / 3600_000;
  if (hLeft < 1) return `${Math.max(1, Math.round(hLeft * 60))}m left`;
  if (hLeft < 24) return `${Math.round(hLeft)}h left`;
  return `${Math.round(hLeft / 24)}d left`;
}
