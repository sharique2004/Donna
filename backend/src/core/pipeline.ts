import type {
  Channel, Donation, DonationItem, RankedRecipient, Weights, AgentConfig,
  CallAttempt, CallOutcome, HistoryEvent,
} from './types.js';
import type { MemoryStore } from './memory/store.js';
import type { LlmClient } from './agents/llm.js';
import type { VoiceProvider } from './voice/caller.js';
import { parseDonation } from './agents/intake.js';
import { composeDonorMessage } from './agents/callback.js';
import {
  startDispatch, onCallReport, type MachineDeps,
} from './voice/dispatchMachine.js';
import { draftOffer } from './agents/offer.js';
import { memoryHint } from './agents/memoryHint.js';
import { rankRecipients } from './scoring/engine.js';

export interface PipelineDeps {
  store: MemoryStore;
  llm: LlmClient;
  voice: VoiceProvider;
  config: AgentConfig;
}

// parse (Agent 1) → build Donation with ids → store → status 'scored'
export async function ingestDonation(
  input: { channel: Channel; contact: string; rawText: string },
  deps: PipelineDeps,
): Promise<Donation> {
  const parsed = await parseDonation(input.rawText, input.channel, deps.llm);

  const donationId = crypto.randomUUID();
  const items: DonationItem[] = parsed.items.map((p) => ({
    id: crypto.randomUUID(),
    donationId,
    item: p.item,
    qtyLbs: p.qtyLbs,
    category: p.category,
    hoursToSpoil: p.hoursToSpoil,
    needsRefrigeration: p.needsRefrigeration,
    status: 'pending',
    attempts: [],
  }));

  const donation: Donation = {
    id: donationId,
    sourceChannel: input.channel,
    sourceContact: input.contact,
    receivedAt: new Date().toISOString(),
    rawText: input.rawText,
    status: 'scored',
    donorName: parsed.donorName,
    pickupLocation: parsed.pickupLocation,
    pickupLat: parsed.pickupLat,
    pickupLng: parsed.pickupLng,
    items,
  };

  await deps.store.saveDonation(donation);
  return donation;
}

/**
 * §G.3.3 — the shared donation-finish check. When NO item of a donation is
 * still `pending`, the donation is done: compose the Agent 5 donor callback,
 * stamp `donorMessage`, flip status to `resolved`, and persist. Returns whether
 * it resolved. dispatchDonation AND both directed/manual call endpoints call
 * this so a directed/manual call that closes the last pending item resolves the
 * donation identically to a full dispatch run.
 */
export async function finishDonationIfResolved(
  donation: Donation,
  deps: Pick<PipelineDeps, 'store' | 'llm'>,
): Promise<boolean> {
  if (donation.items.some((it) => it.status === 'pending')) return false;
  donation.donorMessage = await composeDonorMessage(donation, deps.llm);
  donation.status = 'resolved';
  await deps.store.saveDonation(donation);
  return true;
}

/**
 * Build the state machine's dependencies from a PipelineDeps.
 *
 * This is the seam between "what the app has" (a VoiceProvider, an LlmClient)
 * and "what the machine needs" (place a call, get an id; compose the callback).
 * The machine deliberately knows nothing about VAPI or the simulator.
 */
export function machineDeps(deps: PipelineDeps): MachineDeps {
  const voice = deps.voice;
  return {
    store: deps.store,
    llm: deps.llm,
    config: deps.config,
    placeCall: (offer, recipient, item) => voice.startCall(offer, recipient, item),
    ...(voice.synthesizeReport
      ? { synthesizeReport: voice.synthesizeReport.bind(voice) }
      : {}),
    ...(voice.setHistory
      ? {
          refreshHistory: async () => {
            voice.setHistory!(await deps.store.listHistory());
          },
        }
      : {}),
    composeDonorMessage: (donation) => composeDonorMessage(donation, deps.llm),
  };
}

/**
 * Kick off a dispatch. Returns as soon as the FIRST call is placed — the rest
 * is driven by webhooks (dispatchMachine.onCallReport), not by this function.
 *
 * It used to run the entire donation to completion in one call, blocking for
 * minutes of real telephony. That shape is what pinned the backend to a single
 * always-on process; see dispatchMachine for the why.
 *
 * The returned Donation is therefore a SNAPSHOT taken after the first call goes
 * out — items will still be pending. Read it back from the store to see where
 * the dispatch got to. (Under VOICE_PROVIDER=sim there are no webhooks, so the
 * machine runs to completion synchronously and the snapshot IS the final state.)
 */
export async function dispatchDonation(
  donationId: string,
  deps: PipelineDeps,
): Promise<Donation> {
  const donation = await deps.store.getDonation(donationId);
  if (!donation) throw new Error(`donation not found: ${donationId}`);
  await startDispatch(donation, machineDeps(deps));
  return (await deps.store.getDonation(donationId)) ?? donation;
}

// ---------------------------------------------------------------------------
// §G.3 — directed / manual single-recipient calls (bypass the ranking loop).
// Discriminated result so the HTTP layer can map to 404 / 409 without throwing.
// ---------------------------------------------------------------------------
export type DirectedCallError =
  | 'item_not_found' | 'recipient_not_found' | 'item_not_pending';
/**
 * `attempt` is only present when the outcome is known by the time we return —
 * i.e. a manual log (the human already made the call) or the simulator.
 *
 * A live directed call cannot include one: the call has been placed, but its
 * outcome arrives later at the webhook. `callId` is returned instead so the
 * caller can follow it; the attempt lands on the item once the report comes in.
 */
export type DirectedCallResult =
  | { ok: true; item: DonationItem; attempt?: CallAttempt; callId?: string }
  | { ok: false; error: DirectedCallError };

function genId(): string {
  return crypto.randomUUID();
}

function locateItem(
  donations: Donation[],
  itemId: string,
): { item: DonationItem; donation: Donation } | undefined {
  for (const d of donations) {
    const item = d.items.find((it) => it.id === itemId);
    if (item) return { item, donation: d };
  }
  return undefined;
}

/**
 * Record a placed/logged attempt on an item and run the shared side effects:
 * append to item.attempts, addHistory, and on `accepted` mark the item matched
 * + credit the recipient's ledger. Then persist the donation and run the shared
 * finish check. Mutates `item`/`donation` in place.
 */
async function applyAttempt(
  item: DonationItem,
  donation: Donation,
  recipientName: string,
  recipientId: string,
  attempt: CallAttempt,
  deps: PipelineDeps,
): Promise<void> {
  item.attempts = item.attempts ?? [];
  item.attempts.push(attempt);

  const event: HistoryEvent = {
    id: genId(),
    recipientId,
    itemId: item.id,
    outcome: attempt.outcome,
    reason: attempt.reason,
    at: attempt.at,
  };
  await deps.store.addHistory(event);

  if (attempt.outcome === 'accepted') {
    item.status = 'matched';
    item.matchedRecipientId = recipientId;
    item.resolutionReason = `Accepted by ${recipientName}`;
    await deps.store.creditReceived(recipientId, item.qtyLbs);
  }
  // declined / no_answer: attempt + history recorded; item stays pending so it
  // can be tried again. The category-decline reason feeds the 7-day prefs
  // penalty on the next ranking automatically.

  await deps.store.saveDonation(donation);
  await finishDonationIfResolved(donation, deps);
}

/**
 * §G.3.1 — a directed agent call to one chosen recipient, skipping ranking.
 *
 * The call is placed and its CallRecord is flagged `directed`, which tells the
 * state machine to record the report but NOT steer: no shortlist to walk, and a
 * decline leaves the item pending so the coordinator can try someone else. That
 * is the point of a manual override.
 *
 * Live, the outcome is not known when this returns — `callId` comes back and
 * the attempt lands on the item at the webhook. Simulated, there is no webhook,
 * so the decision is fed through the same path immediately and `attempt` is
 * populated. 404 (unknown item/recipient), 409 (item not pending) surface as
 * `{ ok: false, error }`.
 */
export async function directedCall(
  itemId: string,
  recipientId: string,
  deps: PipelineDeps,
): Promise<DirectedCallResult> {
  const located = locateItem(await deps.store.listDonations(), itemId);
  if (!located) return { ok: false, error: 'item_not_found' };
  const recipient = await deps.store.getRecipient(recipientId);
  if (!recipient) return { ok: false, error: 'recipient_not_found' };
  const { item, donation } = located;
  if (item.status !== 'pending') return { ok: false, error: 'item_not_pending' };

  const offer = await draftOffer(
    item, donation, recipient, memoryHint(recipient, item), deps.llm,
  );
  const md = machineDeps(deps);

  // Publish "dialing X" before the call, exactly as the machine's placeNext
  // does — this path bypasses it, so without this a coordinator's directed call
  // rings with the dashboard showing nothing. onCallReport clears it.
  item.dialing = {
    recipientId: recipient.id,
    recipientName: recipient.name,
    startedAt: new Date().toISOString(),
  };
  await deps.store.saveDonation(donation);

  let callId: string;
  try {
    callId = await deps.voice.startCall(offer, recipient, item);
  } catch (e) {
    item.dialing = undefined;
    await deps.store.saveDonation(donation);
    throw e;
  }
  await deps.store.saveCall({
    callId,
    donationId: donation.id,
    itemId: item.id,
    recipientId: recipient.id,
    candidateIndex: -1,          // not on any shortlist
    placedAt: new Date().toISOString(),
    directed: true,
  });

  if (deps.voice.synthesizeReport) {
    if (deps.voice.setHistory) deps.voice.setHistory(await deps.store.listHistory());
    const r = await deps.voice.synthesizeReport(offer, recipient, item);
    await onCallReport(callId, r.outcome, r.reason, r.transcript, md);
    const fresh = await deps.store.getDonation(donation.id);
    const freshItem = fresh?.items.find((it) => it.id === item.id) ?? item;
    return { ok: true, item: freshItem, attempt: freshItem.attempts.at(-1), callId };
  }

  return { ok: true, item, callId };
}

export interface ManualCallInput {
  outcome: CallOutcome;
  reason?: string;
  notes?: string;
}

/**
 * §G.3.2 — a human-logged call, recorded exactly like an agent call but flagged
 * `manual: true`, `simulated: false`. Transcript = the notes as a single
 * agent-line when provided. Same 404/409 rules and finish semantics as (1).
 */
export async function manualCall(
  itemId: string,
  recipientId: string,
  input: ManualCallInput,
  deps: PipelineDeps,
): Promise<DirectedCallResult> {
  const located = locateItem(await deps.store.listDonations(), itemId);
  if (!located) return { ok: false, error: 'item_not_found' };
  const recipient = await deps.store.getRecipient(recipientId);
  if (!recipient) return { ok: false, error: 'recipient_not_found' };
  const { item, donation } = located;
  if (item.status !== 'pending') return { ok: false, error: 'item_not_pending' };

  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  const attempt: CallAttempt = {
    recipientId: recipient.id,
    recipientName: recipient.name,
    outcome: input.outcome,
    ...(input.reason ? { reason: input.reason } : {}),
    transcript: notes ? [{ speaker: 'agent', text: notes }] : [],
    at: new Date().toISOString(),
    simulated: false,
    manual: true,
  };
  await applyAttempt(item, donation, recipient.name, recipient.id, attempt, deps);
  return { ok: true, item, attempt };
}

// stateless re-rank (slider preview) — optional weights override, does NOT persist
export async function rankItem(
  itemId: string,
  weightsOverride: Weights | undefined,
  deps: PipelineDeps,
): Promise<RankedRecipient[]> {
  let target: DonationItem | undefined;
  let owner: Donation | undefined;
  const donations = await deps.store.listDonations();
  for (const d of donations) {
    const found = d.items.find((it) => it.id === itemId);
    if (found) { target = found; owner = d; break; }
  }
  if (!target || !owner) throw new Error(`item not found: ${itemId}`);

  const recipients = await deps.store.listRecipients();
  const history = await deps.store.listHistory();
  const config: AgentConfig = weightsOverride
    ? { ...deps.config, weights: weightsOverride }
    : deps.config;

  return rankRecipients(target, owner, recipients, config, history);
}
