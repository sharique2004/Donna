import type {
  Donation, DonationItem, OfferDraft, Recipient, CallAttempt, HistoryEvent, AgentConfig,
} from '../types.js';
import type { MemoryStore } from '../memory/store.js';
import type { LlmClient } from '../agents/llm.js';
import { rankRecipients } from '../scoring/engine.js';
import { draftOffer } from '../agents/offer.js';
import { memoryHint } from '../agents/memoryHint.js';

/**
 * The dispatch state machine — the event-driven replacement for caller.ts's
 * blocking loop.
 *
 * The old shape was one long-lived `for` loop with `await placeCall()` in the
 * middle, and a promise parked in an in-memory Map that only the webhook could
 * resolve. That is the single reason the backend needed to be one process that
 * never restarts: a promise in instance A's RAM is invisible to instance B, so
 * a webhook landing on the wrong instance resolved nothing.
 *
 * Same logic, no stack:
 *
 *   approve            → rank item 0, persist shortlist, place call #1, RETURN
 *   report(accepted)   → matched, credit ledger, advance to the next item
 *   report(declined)   → candidateIndex++, place the next call
 *   report, exhausted  → unplaceable, advance to the next item
 *   no items left      → Agent 5 donor callback, donation resolved
 *
 * Every transition reads its state from the store and writes it back, so any
 * invocation on any machine can carry the work forward.
 *
 * Items go strictly one at a time (`donation.itemCursor`). Firing them in
 * parallel would be free here, but LIVE_CALL_PHONE_OVERRIDE points every call
 * at one handset — parallel dispatch would ring the demo phone three times at
 * once.
 */

export interface MachineDeps {
  store: MemoryStore;
  llm: LlmClient;
  config: AgentConfig;
  /** Places the call and returns VAPI's call id. Does NOT wait for the outcome. */
  placeCall(offer: OfferDraft, recipient: Recipient, item: DonationItem): Promise<string>;
  /**
   * Present only for providers with no webhook (the simulator). When set, the
   * machine feeds its decision straight back through onCallReport, so simulated
   * and live dispatches run the identical state transitions.
   */
  synthesizeReport?(
    offer: OfferDraft,
    recipient: Recipient,
    item: DonationItem,
  ): Promise<Pick<CallAttempt, 'outcome' | 'reason' | 'transcript'>>;
  /**
   * Hands the simulator the current decline ledger before it decides, so its
   * 7-day category memory sees declines from earlier in this same run.
   */
  refreshHistory?(): Promise<void>;
  /** Agent 5 — composed once every item is resolved. */
  composeDonorMessage(donation: Donation): Promise<string>;
}

function genId(): string {
  return crypto.randomUUID();
}

/** Offer drafting must never strand a donation; fall back to a plain script. */
async function offerFor(
  item: DonationItem,
  donation: Donation,
  recipient: Recipient,
  llm: LlmClient,
): Promise<OfferDraft> {
  try {
    return await draftOffer(item, donation, recipient, memoryHint(recipient, item), llm);
  } catch {
    return {
      itemId: item.id,
      recipientId: recipient.id,
      summary: `Offer ${item.qtyLbs} lbs of ${item.item} to ${recipient.name}.`,
      script:
        `Hi, this is Donna calling on behalf of a food donor. We have ` +
        `${item.qtyLbs} lbs of ${item.item} available for pickup. ` +
        `Would ${recipient.name} be able to take it today?`,
    };
  }
}

/**
 * Entry point: a human approved the donation. Ranks the first pending item and
 * places one call, then returns — the webhook drives everything after this.
 */
export async function startDispatch(donation: Donation, deps: MachineDeps): Promise<void> {
  donation.status = 'dispatching';
  donation.itemCursor = 0;
  await deps.store.saveDonation(donation);
  await workCursor(donation, deps);
}

/**
 * Work whatever item the cursor points at: skip resolved ones, rank a fresh
 * one, and place its first call. Advances past items that cannot be called at
 * all. Falls through to finishing the donation when the cursor runs out.
 */
async function workCursor(donation: Donation, deps: MachineDeps): Promise<void> {
  for (;;) {
    const i = donation.itemCursor ?? 0;
    if (i >= donation.items.length) {
      await finish(donation, deps);
      return;
    }

    const item = donation.items[i];
    if (item.status !== 'pending') {
      donation.itemCursor = i + 1;
      await deps.store.saveDonation(donation);
      continue;
    }

    // Rank once per item. Re-ranking after each decline would let a recipient
    // that already said no climb back to the top of the list.
    if (!item.candidateRecipientIds) {
      const recipients = await deps.store.listRecipients();
      const history = await deps.store.listHistory();
      const ranked = rankRecipients(item, donation, recipients, deps.config, history);
      item.candidateRecipientIds = ranked
        .filter((r) => !r.score.hardFail)
        .slice(0, 3)
        .map((r) => r.recipient.id);
      item.candidateIndex = 0;
      await deps.store.saveDonation(donation);
    }

    const placed = await placeNext(donation, item, deps);
    if (placed) return;              // now waiting on a webhook

    // Nothing callable for this item — move on.
    donation.itemCursor = i + 1;
    await deps.store.saveDonation(donation);
  }
}

/**
 * Place a call to the current candidate. Returns false when the shortlist is
 * exhausted (item marked unplaceable) so the caller advances the cursor.
 */
async function placeNext(
  donation: Donation,
  item: DonationItem,
  deps: MachineDeps,
): Promise<boolean> {
  const ids = item.candidateRecipientIds ?? [];
  const idx = item.candidateIndex ?? 0;

  if (idx >= ids.length) {
    item.status = 'unplaceable';
    item.resolutionReason = ids.length === 0
      ? `No feasible recipient — every option failed a hard constraint ` +
        `(spoilage window, cold chain, or category).`
      : `No recipient accepted after ${item.attempts.length} call(s): ` +
        `${item.attempts.map((a) => a.recipientName).join(', ')}.`;
    item.dialing = undefined;
    await deps.store.saveDonation(donation);
    return false;
  }

  const recipient = await deps.store.getRecipient(ids[idx]);
  if (!recipient) {                  // deleted mid-dispatch; skip it
    item.candidateIndex = idx + 1;
    await deps.store.saveDonation(donation);
    return placeNext(donation, item, deps);
  }

  const offer = await offerFor(item, donation, recipient, deps.llm);

  // Publish "dialing X" before the call so the dashboard lights up while the
  // phone is actually ringing.
  item.dialing = {
    recipientId: recipient.id,
    recipientName: recipient.name,
    startedAt: new Date().toISOString(),
  };
  await deps.store.saveDonation(donation);

  let callId: string;
  try {
    callId = await deps.placeCall(offer, recipient, item);
  } catch (e) {
    // The call never got off the ground (bad number, VAPI rejected it). Treat
    // it as a no-answer attempt and keep the machine moving rather than
    // stranding the donation at `dispatching` forever.
    item.dialing = undefined;
    await recordAttempt(donation, item, recipient, {
      recipientId: recipient.id,
      recipientName: recipient.name,
      outcome: 'no_answer',
      reason: `call could not be placed: ${e instanceof Error ? e.message : String(e)}`,
      transcript: [],
      at: new Date().toISOString(),
      simulated: Boolean(deps.synthesizeReport),
    }, deps);
    item.candidateIndex = idx + 1;
    await deps.store.saveDonation(donation);
    return placeNext(donation, item, deps);
  }

  await deps.store.saveCall({
    callId,
    donationId: donation.id,
    itemId: item.id,
    recipientId: recipient.id,
    candidateIndex: idx,
    placedAt: new Date().toISOString(),
  });

  // Simulator: no webhook is coming, so deliver its decision through the same
  // door a real report uses. Everything downstream is identical.
  //
  // refreshHistory first — the simulator's 7-day category memory has to see
  // declines recorded earlier in THIS dispatch run, which the old loop did by
  // calling setHistory on every iteration.
  if (deps.synthesizeReport) {
    if (deps.refreshHistory) await deps.refreshHistory();
    const r = await deps.synthesizeReport(offer, recipient, item);
    await onCallReport(callId, r.outcome, r.reason, r.transcript, deps);
  }
  return true;
}

/** Append the attempt + history, and credit the ledger on an accept. */
async function recordAttempt(
  donation: Donation,
  item: DonationItem,
  recipient: Recipient,
  attempt: CallAttempt,
  deps: MachineDeps,
): Promise<void> {
  item.attempts = item.attempts ?? [];
  item.attempts.push(attempt);

  const event: HistoryEvent = {
    id: genId(),
    recipientId: recipient.id,
    itemId: item.id,
    outcome: attempt.outcome,
    reason: attempt.reason,
    at: attempt.at,
  };
  await deps.store.addHistory(event);

  if (attempt.outcome === 'accepted') {
    item.status = 'matched';
    item.matchedRecipientId = recipient.id;
    item.resolutionReason = `Accepted by ${recipient.name}`;
    await deps.store.creditReceived(recipient.id, item.qtyLbs);
  }
  await deps.store.saveDonation(donation);
}

/**
 * A call reported back. Idempotent: the first invocation to claim the callId
 * does the work, any duplicate returns immediately.
 *
 * Returns false when the report belongs to no call we placed (an inbound call,
 * a stale id from a wiped database, a duplicate).
 */
export async function onCallReport(
  callId: string,
  outcome: CallAttempt['outcome'],
  reason: string | undefined,
  transcript: CallAttempt['transcript'],
  deps: MachineDeps,
): Promise<boolean> {
  const call = await deps.store.getCall(callId);
  if (!call) return false;

  // VAPI sends more than one end-of-call-report per call. Without this claim,
  // a duplicate would advance the machine a second time and dial the next
  // pantry twice over.
  const claimed = await deps.store.claimCall(callId, new Date().toISOString());
  if (!claimed) return false;

  const donation = await deps.store.getDonation(call.donationId);
  if (!donation) return false;
  const item = donation.items.find((it) => it.id === call.itemId);
  if (!item) return false;
  const recipient = await deps.store.getRecipient(call.recipientId);

  item.dialing = undefined;
  await deps.store.clearLiveLines(callId);

  if (recipient) {
    await recordAttempt(donation, item, recipient, {
      recipientId: recipient.id,
      recipientName: recipient.name,
      outcome,
      reason,
      transcript,
      at: new Date().toISOString(),
      // A provider that synthesizes its own report is the simulator; anything
      // resolved by a real webhook is a real call.
      simulated: Boolean(deps.synthesizeReport),
    }, deps);
  }

  // A coordinator's directed call (§G.3) is recorded, never steered. It has no
  // shortlist, and a decline deliberately leaves the item pending to be tried
  // again — advancing here would send the automatic dispatch off to the next
  // ranked pantry behind their back. Accepting still resolves the item (done in
  // recordAttempt), so it can still complete the donation.
  if (call.directed) {
    await finish(donation, deps);
    return true;
  }

  if (outcome === 'accepted') {
    donation.itemCursor = (donation.itemCursor ?? 0) + 1;
    await deps.store.saveDonation(donation);
    await workCursor(donation, deps);
    return true;
  }

  // Declined or no-answer: try the next name on the shortlist. placeNext marks
  // the item unplaceable and returns false once the list runs out.
  item.candidateIndex = (item.candidateIndex ?? 0) + 1;
  await deps.store.saveDonation(donation);

  const placed = await placeNext(donation, item, deps);
  if (!placed) {
    donation.itemCursor = (donation.itemCursor ?? 0) + 1;
    await deps.store.saveDonation(donation);
    await workCursor(donation, deps);
  }
  return true;
}

/**
 * The report that never came.
 *
 * The blocking design had a 360s timer per call; on a serverless runtime no
 * timer survives the invocation, so a dropped webhook would strand a donation
 * at `dispatching` forever. A cron trigger calls this to sweep calls that were
 * placed long ago and never reported, recording no_answer and moving on.
 */
export async function sweepStaleCalls(
  olderThanMs: number,
  deps: MachineDeps,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const stale = await deps.store.listUnhandledCallsBefore(cutoff);
  let swept = 0;
  for (const call of stale) {
    const done = await onCallReport(
      call.callId,
      'no_answer',
      'no end-of-call report received',
      [],
      deps,
    );
    if (done) swept++;
  }
  return swept;
}

/** All items resolved ⇒ Agent 5 writes the donor back, donation is done. */
async function finish(donation: Donation, deps: MachineDeps): Promise<void> {
  if (donation.items.some((it) => it.status === 'pending')) return;
  donation.donorMessage = await deps.composeDonorMessage(donation);
  donation.status = 'resolved';
  await deps.store.saveDonation(donation);
}
