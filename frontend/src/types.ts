// Mirrored from backend/src/core/types.ts (ARCHITECTURE §3).
// Frontend and backend are separate packages and cannot import across the boundary,
// so this is a verbatim copy of the shared contract. Do not diverge.

export type Channel = 'voice' | 'sms' | 'email' | 'walk_in' | 'web_form';
export type ItemCategory =
  | 'fresh_produce' | 'fruit' | 'canned' | 'dry_goods' | 'baked'
  | 'dairy' | 'meat' | 'prepared' | 'beverages' | 'other';
export type ItemStatus = 'pending' | 'matched' | 'unplaceable';
export type DonationStatus = 'received' | 'parsed' | 'scored' | 'dispatching' | 'resolved';
export type RecipientType = 'pantry' | 'community_agency';
export type Infrastructure = 'walk_in_fridge' | 'fridge' | 'freezer' | 'dry_storage' | 'loading_dock';
export type CallOutcome = 'accepted' | 'declined' | 'no_answer';

export interface Donation {
  id: string; sourceChannel: Channel; sourceContact: string;
  receivedAt: string; rawText: string; status: DonationStatus;
  donorName?: string; pickupLocation?: string;
  pickupLat?: number; pickupLng?: number;
  items: DonationItem[];
  donorMessage?: string;
}
export interface DonationItem {
  id: string; donationId: string;
  item: string; qtyLbs: number; category: ItemCategory;
  hoursToSpoil: number; needsRefrigeration: boolean;
  status: ItemStatus;
  matchedRecipientId?: string; resolutionReason?: string;
  attempts: CallAttempt[];
}
export interface Recipient {
  id: string; name: string; type: RecipientType;
  leadContact: string; phone: string;
  lat: number; lng: number;
  infrastructure: Infrastructure[];
  accepts: ItemCategory[]; rejects: ItemCategory[];
  typicalWeeklyVolumeLbs: number;
  bestCallWindow?: string;
  receivedRecentLbs: number;
  notes?: string;
}
export interface HistoryEvent {
  id: string; recipientId: string; itemId: string;
  outcome: CallOutcome; reason?: string; at: string;
}
export interface Weights {
  feasibility: number; coldchain: number; capacity: number;
  equity: number; prefs: number;
}
export interface AgentConfig {
  weights: Weights;
  autopilot: boolean;
  avgSpeedMph: number;
}
export interface ScoreBreakdown {
  recipientId: string;
  feasibility: number; coldchain: number; capacity: number;
  equity: number; prefs: number;
  total: number;
  hardFail?: 'infeasible_time' | 'no_cold_chain' | 'category_rejected';
  driveTimeHours: number; distanceMiles: number;
}
export interface RankedRecipient { recipient: Recipient; score: ScoreBreakdown; }
export interface ParsedDonation {
  donorName?: string; pickupLocation?: string;
  pickupLat?: number; pickupLng?: number;
  items: Array<Pick<DonationItem, 'item' | 'qtyLbs' | 'category' | 'hoursToSpoil' | 'needsRefrigeration'>>;
}
export interface OfferDraft { itemId: string; recipientId: string; script: string; summary: string; }
export interface CallAttempt {
  recipientId: string; recipientName: string;
  outcome: CallOutcome; reason?: string;
  transcript: Array<{ speaker: 'agent' | 'recipient'; text: string }>;
  at: string; simulated: boolean;
  manual?: boolean;                 // §G.3 — human-logged intervention (renders 👤, not SIM)
}
// §G.3 — POST /api/items/:itemId/call/:recipientId (directed agent call) and
// POST /api/items/:itemId/manual/:recipientId (human log) both return this shape.
export interface DirectedCallResponse { item: DonationItem; attempt: CallAttempt; }
export interface ManualCallInput { outcome: CallOutcome; reason?: string; notes?: string; }
// §D.5 / §F — one flattened call-log row per CallAttempt, tagged with its donation
// and item. Mirrors backend/src/server.ts CallLogEntry (GET /api/calls, newest
// first). Feeds the Outbound feed.
export type CallLogEntry = {
  donationId: string;
  itemId: string;
  itemName: string;
} & CallAttempt;
export interface ConfigPatch {
  op: 'set_accepts' | 'add_infrastructure' | 'remove_infrastructure'
    | 'set_rejects' | 'set_weights' | 'set_autopilot' | 'set_note' | 'set_volume';
  recipientId?: string;
  value: unknown;
}
export interface ManagerReply { reply: string; patches: ConfigPatch[]; applied: boolean; }
export interface EquitySimResult {
  drops: number;
  nearest: { perRecipientLbs: Record<string, number>; minMaxRatio: number; gini: number };
  donna: { perRecipientLbs: Record<string, number>; minMaxRatio: number; gini: number };
  series: Array<{ drop: number; nearestGini: number; donnaGini: number }>;
}

// ---- API response envelopes (ARCHITECTURE §9) ----
export type Mode = { llm: string; db: string; voice: string };
export interface HealthResponse { ok: boolean; mode: Mode; warnings?: string[] }
export type Rankings = Record<string, RankedRecipient[]>;
export interface EnrichedDonation {
  donation: Donation;
  rankings: Rankings;
  warnings?: string[];
}
export interface RankResponse {
  rankings: RankedRecipient[];
  explanation: string;
  warnings?: string[];
}

export const TERM_KEYS = ['feasibility', 'coldchain', 'capacity', 'equity', 'prefs'] as const;
export type TermKey = (typeof TERM_KEYS)[number];
