import { ENV } from '../../config.js';
import { IN_CALL_MODEL } from './vapi.js';

/**
 * Inbound telephony — a donor phones the food bank and Donna answers.
 *
 * PRD §15 listed inbound as out of scope for v1 ("use transcripts"), so this is
 * new ground for the stage demo. It is also the first path where Agent 1 does
 * real work: /api/demo/canned hardcodes the mock parser, so until now nothing
 * exercised live intake parsing end to end.
 *
 * Shape (docs.vapi.ai, verified 2026-07): a phone number with `assistantId: null`
 * and a `server.url` makes VAPI POST an `assistant-request` when a call lands. We
 * answer with a transient assistant inline — the definition stays in code next to
 * the outbound one instead of drifting inside a dashboard. VAPI gives us 7.5s to
 * respond, which is why this builder is static config and never calls a model.
 */

/**
 * Who Donna says she works for.
 *
 * Configurable because a real deployment is a specific food bank — but it MUST
 * be an organisation the operator actually runs. Never set this to a real food
 * bank you are not: the assistant states it as fact to whoever picks up.
 */
const FOOD_BANK_NAME = ENV.foodBankName;

/** Donna's inbound greeting — the first thing a donor hears on stage. */
const INBOUND_GREETING =
  `Thanks for calling ${FOOD_BANK_NAME} — this is Donna. What have you got to donate today?`;

/**
 * Observed live 2026-07-16: asked "who is this?", the model answered "this is the
 * Central City Food Bank" — an organisation that exists nowhere in this system.
 * The earlier prompt said only "a food bank" and named none, so the model filled
 * the hole. The outbound assistant did the same thing with provenance, inventing
 * "a farm just outside Watsonville" when the donation record plainly said Golden
 * State Produce, Dock 12.
 *
 * Both are the same failure: an unanswerable question plus no instruction to
 * decline produces a confident invention. In this domain that is not cosmetic —
 * sourcing and identity are food-safety facts, and the people on the other end
 * make decisions from them. Hence the explicit name above and the do-not-invent
 * rule below.
 */
const INBOUND_SYSTEM =
  `You are Donna, the intake dispatcher for ${FOOD_BANK_NAME}. A donor is calling to ` +
  "offer surplus food. Your ONLY job is to find out what they have, and for each " +
  "distinct item: roughly how much (weight, pallets, or cases is fine), and how " +
  "soon it will spoil. Ask about refrigeration only if it is not obvious. " +
  "Also get where it can be picked up, and the donor's name. " +
  "Be warm, brief, and natural — this is a phone call, not a form. Ask one " +
  "question at a time. Never promise that a specific pantry will take it; say the " +
  "team will confirm shortly and call them back. When you have the items, quantities, " +
  "spoilage window, and pickup location, thank them by name and end the call. " +
  "If you did not understand an item, ask them to repeat it rather than guessing. " +
  "NEVER invent facts. You work for " + FOOD_BANK_NAME + " and nothing else — do not " +
  "make up a different organisation name, address, partner, or policy. If you are " +
  "asked something you were not told (which pantry gets this, who else donates, how " +
  "the system works internally), say you do not have that in front of you and the " +
  "team will follow up. A wrong answer said confidently is worse than 'I'll check'. " +
  "If asked, you are an AI assistant — say so plainly and do not pretend otherwise.";

/**
 * The transient assistant returned for an `assistant-request`.
 *
 * `serverMessages` includes `transcript` so the stage dashboard can render live
 * captions while the donor is still speaking — the outbound assistant narrows to
 * end-of-call-report only, because nothing watches those in real time.
 */
export function buildInboundAssistant() {
  return {
    name: 'Donna Intake',
    firstMessage: INBOUND_GREETING,
    maxDurationSeconds: 300,
    model: {
      ...IN_CALL_MODEL,
      messages: [{ role: 'system', content: INBOUND_SYSTEM }],
    },
    voice: { provider: '11labs', voiceId: 'burt' },
    ...(ENV.publicWebhookUrl
      ? {
          server: {
            url: `${ENV.publicWebhookUrl}/api/vapi/webhook`,
            timeoutSeconds: 20,
            ...(ENV.vapiWebhookSecret ? { secret: ENV.vapiWebhookSecret } : {}),
          },
          serverMessages: ['end-of-call-report', 'transcript'],
        }
      : {}),
  };
}

/**
 * Is this report for a call the donor placed to us, rather than one we placed?
 *
 * Primary signal is VAPI's own call.type. The transcript fallback exists because
 * an outbound report only reaches this check after failing to match a pending
 * call (server restarted mid-call, duplicate delivery) — in that case there is
 * nothing to resolve either way, and a donation built from a pantry conversation
 * is worse than none. So the fallback stays conservative: type must be absent.
 */
export function isInboundCall(call: Record<string, unknown>): boolean {
  const type = String(call.type ?? '');
  if (type) return type === 'inboundPhoneCall';
  return false;
}

/**
 * The raw text Agent 1 parses from an inbound call.
 *
 * Deliberately the WHOLE dialogue, not just the donor's lines: the donor's
 * answers are only meaningful next to Donna's questions. "About two hundred
 * pounds" and "maybe 48 hours" are unparseable alone, but trivial after
 * "How much of it?" and "How long before it spoils?". The intake prompt handles
 * conversational text fine — it is the same shape as a voicemail transcript.
 */
export function transcriptToRawText(transcript: string): string {
  return String(transcript ?? '').trim();
}
