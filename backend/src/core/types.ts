export type Channel = 'voice' | 'sms' | 'email' | 'walk_in' | 'web_form';
export type ItemCategory =
  | 'fresh_produce' | 'fruit' | 'canned' | 'dry_goods' | 'baked'
  | 'dairy' | 'meat' | 'prepared' | 'beverages' | 'other';
export type ItemStatus = 'pending' | 'matched' | 'unplaceable';
/**
 * `awaiting_triage` — parsed and scored, but NOT yet dispatched: it is waiting on
 * a human to approve the calls (PRD §10). Inbound donations land here, and only
 * POST /api/donations/:id/approve moves them on. The autopilot/confirm gate used
 * to be enforced client-side only, which made it a UI courtesy rather than a
 * guarantee; this status is what makes it real.
 */
export type DonationStatus =
  | 'received' | 'parsed' | 'scored' | 'awaiting_triage' | 'dispatching' | 'resolved';
export type RecipientType = 'pantry' | 'community_agency';
export type Infrastructure = 'walk_in_fridge' | 'fridge' | 'freezer' | 'dry_storage' | 'loading_dock';
export type CallOutcome = 'accepted' | 'declined' | 'no_answer';

export interface Donation {
  id: string; sourceChannel: Channel; sourceContact: string;
  receivedAt: string; rawText: string; status: DonationStatus;
  donorName?: string; pickupLocation?: string;
  pickupLat?: number; pickupLng?: number;
  items: DonationItem[];
  donorMessage?: string;            // Agent 5 output once resolved
}
export interface DonationItem {
  id: string; donationId: string;
  item: string; qtyLbs: number; category: ItemCategory;
  hoursToSpoil: number; needsRefrigeration: boolean;
  status: ItemStatus;
  /**
   * Set while a call to this recipient is ringing/connected, cleared when it
   * ends. Lets the stage dashboard say "calling Bayview now" instead of waiting
   * for the whole dispatch to finish before anything appears.
   */
  dialing?: { recipientId: string; recipientName: string; startedAt: string };
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
  receivedRecentLbs: number;        // rolling ledger total — fuels equity term
  notes?: string;
}
export interface HistoryEvent {
  id: string; recipientId: string; itemId: string;
  outcome: CallOutcome; reason?: string; at: string;
}
export interface Weights {
  feasibility: number; coldchain: number; capacity: number;
  equity: number; prefs: number;    // each 0..1; engine normalizes by sum
}
export interface AgentConfig {
  weights: Weights;
  autopilot: boolean;               // false ⇒ human-confirm gate before calls
  avgSpeedMph: number;              // default 30
}
export interface ScoreBreakdown {
  recipientId: string;
  feasibility: number; coldchain: number; capacity: number;
  equity: number; prefs: number;    // each 0..1
  total: number;                    // 0..1 weighted
  hardFail?: 'infeasible_time' | 'no_cold_chain' | 'category_rejected';
  driveTimeHours: number; distanceMiles: number;
}
export interface RankedRecipient { recipient: Recipient; score: ScoreBreakdown; }
export interface ParsedDonation {
  donorName?: string; pickupLocation?: string;
  pickupLat?: number; pickupLng?: number;
  items: Array<Pick<DonationItem,'item'|'qtyLbs'|'category'|'hoursToSpoil'|'needsRefrigeration'>>;
}
export interface OfferDraft { itemId: string; recipientId: string; script: string; summary: string; }
export interface CallAttempt {
  recipientId: string; recipientName: string;
  outcome: CallOutcome; reason?: string;
  transcript: Array<{ speaker: 'agent' | 'recipient'; text: string }>;
  at: string; simulated: boolean;
  manual?: boolean;                 // v1.3 §G.3.2 — human-logged call (not agent/sim)
}
export interface ConfigPatch {                       // Agent 4 output — declarative only
  op: 'set_accepts' | 'add_infrastructure' | 'remove_infrastructure'
    | 'set_rejects' | 'set_weights' | 'set_autopilot' | 'set_note' | 'set_volume';
  recipientId?: string;             // required for recipient-targeted ops
  value: unknown;
}
export interface ManagerReply { reply: string; patches: ConfigPatch[]; applied: boolean; }
export interface EquitySimResult {
  drops: number;
  nearest: { perRecipientLbs: Record<string, number>; minMaxRatio: number; gini: number };
  donna:   { perRecipientLbs: Record<string, number>; minMaxRatio: number; gini: number };
  series: Array<{ drop: number; nearestGini: number; donnaGini: number }>;
}
