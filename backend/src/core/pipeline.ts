import { randomUUID } from 'node:crypto';
import type {
  Channel, Donation, DonationItem, RankedRecipient, Weights, AgentConfig,
  CallAttempt, CallOutcome, HistoryEvent,
} from './types.js';
import type { MemoryStore } from './memory/store.js';
import type { LlmClient } from './agents/llm.js';
import type { VoiceProvider } from './voice/caller.js';
import { parseDonation } from './agents/intake.js';
import { composeDonorMessage } from './agents/callback.js';
import { dispatchItem } from './voice/caller.js';
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

  const donationId = randomUUID();
  const items: DonationItem[] = parsed.items.map((p) => ({
    id: randomUUID(),
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

// all pending items → dispatchItem → Agent 5 composeDonorMessage → donorMessage → 'resolved'
export async function dispatchDonation(
  donationId: string,
  deps: PipelineDeps,
): Promise<Donation> {
  const donation = await deps.store.getDonation(donationId);
  if (!donation) throw new Error(`donation not found: ${donationId}`);

  donation.status = 'dispatching';
  await deps.store.saveDonation(donation);

  for (let i = 0; i < donation.items.length; i++) {
    if (donation.items[i].status === 'pending') {
      donation.items[i] = await dispatchItem(
        donation.items[i], donation, deps.store, deps.config, deps,
      );
      // Persist per item so a watching dashboard sees each one resolve as it
      // happens; dispatchItem also saves around each individual call attempt.
      await deps.store.saveDonation(donation);
    }
  }

  await finishDonationIfResolved(donation, deps);
  return donation;
}

// ---------------------------------------------------------------------------
// §G.3 — directed / manual single-recipient calls (bypass the ranking loop).
// Discriminated result so the HTTP layer can map to 404 / 409 without throwing.
// ---------------------------------------------------------------------------
export type DirectedCallError =
  | 'item_not_found' | 'recipient_not_found' | 'item_not_pending';
export type DirectedCallResult =
  | { ok: true; item: DonationItem; attempt: CallAttempt }
  | { ok: false; error: DirectedCallError };

function genId(): string {
  return randomUUID();
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
 * draftOffer → voice.placeCall → applyAttempt. 404 (unknown item/recipient),
 * 409 (item not pending) surface as `{ ok: false, error }`.
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
  const attempt = await deps.voice.placeCall(offer, recipient, item);
  await applyAttempt(item, donation, recipient.name, recipient.id, attempt, deps);
  return { ok: true, item, attempt };
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
