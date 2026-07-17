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
  /**
   * Which item the dispatch machine is currently working, once approved.
   *
   * Items are dispatched strictly one at a time. Nothing technical requires
   * that — event-driven, every item's first call could fire at once — but with
   * LIVE_CALL_PHONE_OVERRIDE every call lands on one handset, so parallel
   * dispatch would ring the demo phone three times simultaneously. Sequential
   * also matches the behaviour verified on real calls.
   */
  itemCursor?: number;
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
  /**
   * The ranked shortlist this item is working through, and how far in.
   *
   * The old blocking loop held these on the JS stack: `for (const candidate of
   * candidates)` with an `await placeCall()` inside. Event-driven there is no
   * stack to hold them — the webhook that decides "call the next one" is a
   * different invocation entirely — so the shortlist is computed once at
   * approve and persisted here.
   *
   * Ranked once, deliberately: re-ranking after each decline would let a
   * recipient that already said no climb back to the top.
   */
  candidateRecipientIds?: string[];
  candidateIndex?: number;
}

/**
 * A call we placed and are waiting to hear about — the row that replaces
 * vapi.ts's in-memory `pending` map.
 *
 * That map is the only reason the backend needed to be a single long-lived
 * process: a promise parked in one instance's RAM can only be resolved by that
 * instance. Persisted here, any invocation can handle any webhook.
 *
 * `handledAt` is the idempotency guard. VAPI provably sends more than one
 * end-of-call-report per call (see the premature `call.in-progress.*` report),
 * and without this a duplicate would drive the machine forward twice and
 * double-dial the next pantry.
 */
export interface CallRecord {
  callId: string;
  donationId: string;
  itemId: string;
  recipientId: string;
  candidateIndex: number;
  placedAt: string;
  handledAt?: string;
  /**
   * A coordinator picked this recipient by hand (§G.3), bypassing the ranking.
   *
   * The report is recorded identically, but the machine must NOT advance: a
   * directed call has no shortlist to walk, and a decline leaves the item
   * `pending` so it can be tried again — which is the whole point of a manual
   * override. Without this flag a declined directed call would march the
   * automatic dispatch on to the next-ranked pantry behind the coordinator's
   * back.
   */
  directed?: boolean;
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
