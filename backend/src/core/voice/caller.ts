import type {
  Donation, DonationItem, OfferDraft, Recipient, CallAttempt, AgentConfig,
  HistoryEvent,
} from '../types.js';
import type { MemoryStore } from '../memory/store.js';
import type { LlmClient } from '../agents/llm.js';
import { rankRecipients } from '../scoring/engine.js';
import { draftOffer } from '../agents/offer.js';
import { memoryHint } from '../agents/memoryHint.js';
import { ENV } from '../../config.js';
import { SimulatorVoice } from './simulator.js';
import { VapiVoice } from './vapi.js';

/**
 * Agent 3 — the outbound voice provider.
 * `setHistory` is an optional hook: the simulator uses it to see the live
 * decline ledger (for its 7-day category memory) without changing placeCall's
 * signature. The live VAPI provider ignores it.
 */
export interface VoiceProvider {
  placeCall(offer: OfferDraft, recipient: Recipient, item: DonationItem): Promise<CallAttempt>;
  setHistory?(history: HistoryEvent[]): void;
}

export function createVoice(): VoiceProvider {   // env VOICE_PROVIDER: 'sim'(default)|'vapi'
  // VapiVoice compiles/constructs with zero keys; it only needs env when a call
  // is actually placed. All VAPI specifics stay inside vapi.ts.
  if (ENV.voiceProvider === 'vapi') return new VapiVoice();
  return new SimulatorVoice();
}

export interface DispatchDeps {
  store: MemoryStore;
  llm: LlmClient;
  voice: VoiceProvider;
  config: AgentConfig;
}

/**
 * Persist mid-dispatch progress. Best-effort by design: a failed write must
 * never abort a dispatch that is placing real phone calls — the worst case is a
 * dashboard that lags, not a donation that stalls with a pantry on the line.
 */
async function saveProgress(donation: Donation, store: MemoryStore): Promise<void> {
  try {
    await store.saveDonation(donation);
  } catch (e) {
    console.warn('[dispatch] progress save failed (continuing):', e instanceof Error ? e.message : e);
  }
}

function genId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `id_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * A single humane contextual clause for the offer drafter (Agent 2).
 * UI_REDESIGN §D.3: the offer must NEVER recite a recipient's DB row, so we
 * hand it at most one short, already-distilled clause (or '' for none) rather
 * than an enumerated Infrastructure/Prefers/Does-not-take dump.
 */
function buildMemoryContext(recipient: Recipient, item: DonationItem): string {
  return memoryHint(recipient, item);
}

/**
 * §7.1 — the dispatch loop.
 * rank → up to 3 candidates → draftOffer → placeCall.
 *   accepted → matched + creditReceived + history + stop.
 *   declined/no_answer → history (w/ reason) + continue.
 *   exhausted → unplaceable with resolutionReason.
 * Every attempt is appended to item.attempts.
 */
export async function dispatchItem(
  item: DonationItem,
  donation: Donation,
  store: MemoryStore,
  config: AgentConfig,
  deps: DispatchDeps,
): Promise<DonationItem> {
  const recipients = await store.listRecipients();
  const history = await store.listHistory();
  const ranked = rankRecipients(item, donation, recipients, config, history);

  // Only recipients that clear the hard gates are callable; take the best three.
  const candidates = ranked.filter((r) => !r.score.hardFail).slice(0, 3);

  item.attempts = item.attempts ?? [];

  for (const candidate of candidates) {
    const recipient = candidate.recipient;

    // Refresh history each iteration so the simulator's 7-day memory reflects
    // declines recorded earlier in this same dispatch run.
    if (deps.voice.setHistory) {
      deps.voice.setHistory(await store.listHistory());
    }

    const memoryContext = buildMemoryContext(recipient, item);

    let offer: OfferDraft;
    try {
      offer = await draftOffer(item, donation, recipient, memoryContext, deps.llm);
    } catch {
      // Offer drafting must never abort the loop — fall back to a plain script.
      offer = {
        itemId: item.id,
        recipientId: recipient.id,
        summary: `Offer ${item.qtyLbs} lbs of ${item.item} to ${recipient.name}.`,
        script:
          `Hi, this is Donna calling on behalf of a food donor. We have ` +
          `${item.qtyLbs} lbs of ${item.item} available for pickup. ` +
          `Would ${recipient.name} be able to take it today?`,
      };
    }

    // Publish "dialing X" BEFORE the call so a polling dashboard sees it while
    // the phone is actually ringing. dispatchDonation only used to persist once
    // the entire run finished, which left the UI blind for minutes.
    item.dialing = {
      recipientId: recipient.id,
      recipientName: recipient.name,
      startedAt: new Date().toISOString(),
    };
    await saveProgress(donation, store);

    let attempt: CallAttempt;
    try {
      attempt = await deps.voice.placeCall(offer, recipient, item);
    } finally {
      item.dialing = undefined;
    }
    item.attempts.push(attempt);
    await saveProgress(donation, store);

    const event: HistoryEvent = {
      id: genId(),
      recipientId: recipient.id,
      itemId: item.id,
      outcome: attempt.outcome,
      reason: attempt.reason,
      at: attempt.at,
    };
    await store.addHistory(event);

    if (attempt.outcome === 'accepted') {
      item.status = 'matched';
      item.matchedRecipientId = recipient.id;
      item.resolutionReason = `Accepted by ${recipient.name}`;
      await store.creditReceived(recipient.id, item.qtyLbs);
      return item;
    }
    // declined or no_answer: history is recorded (a category-decline reason
    // feeds the 7-day prefs penalty automatically on the next ranking); continue.
  }

  // No candidate accepted.
  item.status = 'unplaceable';
  if (candidates.length === 0) {
    item.resolutionReason =
      `No feasible recipient — every option failed a hard constraint ` +
      `(spoilage window, cold chain, or category).`;
  } else {
    const names = candidates.map((c) => c.recipient.name).join(', ');
    item.resolutionReason =
      `No recipient accepted after ${item.attempts.length} call(s): ${names}.`;
  }
  return item;
}
