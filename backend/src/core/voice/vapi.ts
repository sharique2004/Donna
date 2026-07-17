import type {
  DonationItem, OfferDraft, Recipient, CallAttempt, CallOutcome,
} from '../types.js';
import type { VoiceProvider } from './caller.js';
import { ENV } from '../../config.js';

/**
 * §7.3 — live VAPI voice provider.
 *
 * ALL VAPI-specific request/response/webhook shapes live in this file only.
 * Verified against https://docs.vapi.ai (2026-07):
 *   - Outbound call: POST https://api.vapi.ai/call
 *       { phoneNumberId, customer: { number }, assistant: {...transient...} }
 *     Response: { id, ... } — `id` is the call id we correlate on.
 *   - Webhook (server messages): { message: { type: 'end-of-call-report',
 *       endedReason, call: { id }, artifact: { transcript, messages } } }
 *
 * startCall places the call and returns its id, nothing more. The outcome comes
 * back at the webhook and is correlated through the persisted CallRecord — see
 * dispatchMachine. This file holds no cross-request state, which is what lets
 * the backend run on a serverless runtime at all.
 */

const VAPI_BASE = 'https://api.vapi.ai';

/**
 * Hard ceiling on a single call, enforced by VAPI itself (`maxDurationSeconds`).
 * A recipient deciding on a pallet of produce needs far more than a few seconds,
 * but no legitimate offer call runs past five minutes.
 */
const MAX_CALL_DURATION_S = 300;

/**
 * The model that actually talks on the phone — VAPI's in-call ASR→LLM→TTS loop,
 * NOT the backend LlmClient (that one is chosen by LLM_PROVIDER and does intake,
 * offers, manager chat, and the donor callback).
 *
 * Google/Gemini rather than OpenAI: the pitch says Gemini, so the voice should
 * be Gemini too, and it keeps every model in the system on one provider we hold
 * the key for. Requires a `google` credential on the VAPI account (Gemini API
 * key from AI Studio) — without it VAPI rejects the call, it does not fall back.
 *
 * Shared by both assistants so the inbound donor and the outbound pantry never
 * end up on different models. `flash` because a phone call is latency-critical.
 */
export const IN_CALL_MODEL = {
  provider: 'google',
  model: 'gemini-2.5-flash',
} as const;

/**
 * How long after placing a call we give up waiting for its report.
 *
 * This used to be an in-process `setTimeout` racing the webhook. No timer
 * survives a serverless invocation, so the backstop is now a cron sweep
 * (dispatchMachine.sweepStaleCalls) over calls that were placed and never
 * reported. Same purpose, different mechanism: a dropped webhook must never
 * strand a donation at `dispatching` forever.
 *
 * Derived from the call's own ceiling plus a delivery buffer, so the report
 * always beats the sweep. The old value was 90s flat — shorter than a real
 * conversation. Observed live 2026-07-16: a recipient talked for ~100s and
 * declined, the timer fired first and logged `no_answer` over a genuine
 * decline (poisoning the memory PRD §9 learns from) and dialled the next
 * pantry while the first was still connected.
 */
export const CALL_REPORT_GRACE_MS = (MAX_CALL_DURATION_S + 60) * 1000;

/** endedReason values that mean nobody picked up. */
const NO_ANSWER_REASONS = new Set([
  'customer-did-not-answer',
  'customer-busy',
  'voicemail',
  'no-answer',
  'twilio-failed-to-connect-call',
  'phone-call-provider-closed-websocket',
]);

export interface NormalizedWebhook {
  type: 'end-of-call-report';
  callId: string;
  transcript: Array<{ speaker: 'agent' | 'recipient'; text: string }>;
  outcome: CallOutcome;
  reason?: string;
}

/**
 * Where VAPI posts this call's end-of-call-report, and what it's allowed to post.
 *
 * Verified against docs.vapi.ai (2026-07): `server: { url, secret, timeoutSeconds }`
 * plus `serverMessages: [...]` on the assistant. The 2024-10-13 changelog retired
 * the older top-level `serverUrl`/`serverUrlSecret` in favour of this block.
 *
 * `serverMessages` asks for exactly the two messages we act on:
 *   - end-of-call-report drives the dispatch machine (the outcome).
 *   - transcript feeds the live captions on the stage dashboard.
 *
 * `transcript` used to be omitted here, back when nothing consumed it and the
 * narrowing existed to stop status-update/speech-update chatter. Once live
 * captions were built, that omission meant the dashboard could only ever show
 * an INBOUND donor call — the outbound pantry call, which is the one on stage,
 * stayed silent. inbound.ts had it right; this did not. Keep the two lists in
 * step: anything server.ts handles must be requested by both assistants.
 *
 * Returns {} when PUBLIC_WEBHOOK_URL is unset, which leaves the call unable to
 * report back; startCall warns about exactly that below.
 */
function serverBlock() {
  if (!ENV.publicWebhookUrl) return {};
  return {
    server: {
      url: `${ENV.publicWebhookUrl}/api/vapi/webhook`,
      timeoutSeconds: 20,
      ...(ENV.vapiWebhookSecret ? { secret: ENV.vapiWebhookSecret } : {}),
    },
    serverMessages: ['end-of-call-report', 'transcript'],
  };
}

function buildAssistant(offer: OfferDraft, recipient: Recipient, item: DonationItem) {
  return {
    ...serverBlock(),
    // VAPI ends the call here; CALL_TIMEOUT_MS is deliberately longer so the
    // report always wins the race against our own backstop.
    maxDurationSeconds: MAX_CALL_DURATION_S,
    firstMessage: offer.script,
    model: {
      ...IN_CALL_MODEL,
      messages: [
        {
          role: 'system',
          content:
            `You are Donna, a food-rescue dispatcher calling ${recipient.name}. ` +
            `Offer them ${item.qtyLbs} lbs of ${item.item}` +
            `${item.needsRefrigeration ? ' (needs refrigeration)' : ''}. ` +
            `Your only goal is to secure a clear ACCEPT or DECLINE and, if declined, ` +
            `the reason. Be brief and warm. When the recipient decides, confirm and end the call.`,
        },
      ],
    },
    voice: { provider: '11labs', voiceId: 'burt' },
  };
}

/**
 * The number this call is actually dialed to.
 *
 * LIVE_CALL_PHONE_OVERRIDE redirects every outbound call to one handset. This is
 * the ONLY place a dial target is chosen, so nothing upstream — ranking, offer
 * drafting, the recipient's own `phone` field — can route around it. The returned
 * CallAttempt still credits the recipient the engine actually picked.
 */
function dialTarget(recipient: Recipient): string {
  const override = ENV.liveCallPhoneOverride;
  if (!override) return recipient.phone;
  console.warn(
    `[vapi] LIVE_CALL_PHONE_OVERRIDE active — dialing ${override} ` +
      `instead of ${recipient.name} (${recipient.phone}).`,
  );
  return override;
}

export class VapiVoice implements VoiceProvider {
  /**
   * Place the call and return VAPI's call id. Returns as soon as the call is
   * accepted for dialling — the outcome arrives later, at the webhook, and is
   * correlated back through the persisted CallRecord.
   */
  async startCall(
    offer: OfferDraft,
    recipient: Recipient,
    item: DonationItem,
  ): Promise<string> {
    if (!ENV.vapiApiKey || !ENV.vapiPhoneNumberId) {
      throw new Error('VAPI_API_KEY and VAPI_PHONE_NUMBER_ID are required for VOICE_PROVIDER=vapi');
    }
    if (!ENV.publicWebhookUrl) {
      // Not fatal — the call still connects and a human still hears the offer —
      // but nothing can report the outcome back, so this item will sit at
      // `dialing` until the cron sweep writes it off as no_answer.
      console.warn(
        '[vapi] PUBLIC_WEBHOOK_URL is unset: no server block on the assistant, so ' +
          'no end-of-call-report can reach us. This call cannot resolve on its own ' +
          "and will be swept as no_answer regardless of the recipient's answer.",
      );
    }

    const res = await fetch(`${VAPI_BASE}/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ENV.vapiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phoneNumberId: ENV.vapiPhoneNumberId,
        customer: { number: dialTarget(recipient) },
        assistant: buildAssistant(offer, recipient, item),
      }),
    });

    if (!res.ok) {
      throw new Error(`VAPI call failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as { id?: string };
    const callId = data.id;
    if (!callId) throw new Error('VAPI call response missing id');
    return callId;
  }
}

// resolveCall() and the `pending` map are gone. A webhook no longer resolves a
// promise held in this process's memory — it looks the call up in the store and
// drives the state machine (see dispatchMachine.onCallReport). That is what
// lets any invocation, on any machine, carry a dispatch forward.

/** Map a VAPI messages[] array ({role, message}) into our transcript shape. */
function normalizeTranscript(
  messages: unknown,
): Array<{ speaker: 'agent' | 'recipient'; text: string }> {
  if (!Array.isArray(messages)) return [];
  const out: Array<{ speaker: 'agent' | 'recipient'; text: string }> = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = String((m as Record<string, unknown>).role ?? '');
    const text = String(
      (m as Record<string, unknown>).message ?? (m as Record<string, unknown>).content ?? '',
    );
    if (!text) continue;
    if (role === 'system') continue;
    // VAPI: 'assistant'/'bot' = our agent; 'user'/'customer' = the recipient.
    const speaker: 'agent' | 'recipient' =
      role === 'assistant' || role === 'bot' ? 'agent' : 'recipient';
    out.push({ speaker, text });
  }
  return out;
}

/**
 * Decide accept/decline/no_answer from the report. VAPI does not ship a
 * guaranteed structured accept flag, so we consult (in order): a boolean/label
 * successEvaluation from analysis, then the summary/transcript text, then the
 * endedReason for the no-answer cases.
 */
function deriveOutcome(msg: Record<string, unknown>): { outcome: CallOutcome; reason?: string } {
  const endedReason = String(msg.endedReason ?? '');
  if (NO_ANSWER_REASONS.has(endedReason)) {
    return { outcome: 'no_answer', reason: endedReason };
  }

  const analysis = (msg.analysis ?? {}) as Record<string, unknown>;
  const artifact = (msg.artifact ?? {}) as Record<string, unknown>;
  const summary = String(
    analysis.summary ?? msg.summary ?? artifact.summary ?? '',
  ).toLowerCase();
  const transcriptText = String(artifact.transcript ?? msg.transcript ?? '').toLowerCase();
  const hay = `${summary} ${transcriptText}`;

  const success = analysis.successEvaluation;
  if (typeof success === 'boolean') {
    return success
      ? { outcome: 'accepted' }
      : { outcome: 'declined', reason: summary || 'declined' };
  }
  if (typeof success === 'string') {
    const s = success.toLowerCase();
    if (s === 'true' || s === 'pass' || s === 'accepted' || s === 'yes') {
      return { outcome: 'accepted' };
    }
    if (s === 'false' || s === 'fail' || s === 'declined' || s === 'no') {
      return { outcome: 'declined', reason: summary || 'declined' };
    }
  }

  // Text heuristic fallback.
  const declined = /\b(declin|can't take|cannot take|no thanks|not able|don't need|full|overstock)/.test(hay);
  const accepted = /\b(accept|yes|we'll take|we can take|sounds good|bring it|works for us)/.test(hay);
  if (declined && !accepted) return { outcome: 'declined', reason: summary || 'declined' };
  if (accepted) return { outcome: 'accepted' };
  // Ambiguous but the call connected — treat as declined so dispatch keeps trying.
  return { outcome: 'declined', reason: summary || endedReason || 'no clear acceptance' };
}

/**
 * Normalize a raw VAPI webhook body into NormalizedWebhook.
 * Body wrapper: { message: { type, endedReason, call: { id }, artifact, analysis } }.
 * Throws if the message is not an end-of-call-report we can act on.
 */
export function parseWebhook(body: unknown): NormalizedWebhook {
  const root = (body ?? {}) as Record<string, unknown>;
  const msg = (root.message ?? root) as Record<string, unknown>;

  const type = String(msg.type ?? '');
  if (type !== 'end-of-call-report') {
    throw new Error(`Unsupported VAPI webhook type: ${type || '(none)'}`);
  }

  // VAPI posts TWO end-of-call-reports per call. The first fires while the call
  // is still winding down — endedReason `call.in-progress.*`, empty analysis,
  // empty transcript. The second, seconds later, carries the real endedReason
  // (`customer-ended-call`), successEvaluation, and transcript.
  //
  // resolveCall() resolves on first match and drops the pending entry, so acting
  // on the premature one means every call derives `declined` (no data ⇒ the
  // ambiguous fallback) and the real acceptance arrives to find nothing pending.
  // Observed live 2026-07-16: recipient said "Yes. I will be able to take them
  // today.", successEvaluation 'true' — and dispatch still rang the next pantry.
  //
  // Gate on endedReason, NOT on "is the payload empty": a real no-answer report
  // is also empty (no transcript, no analysis) but must still resolve, or the
  // dispatch hangs for the full 90s timeout.
  const endedReason = String(msg.endedReason ?? '');
  if (endedReason.startsWith('call.in-progress.')) {
    throw new Error(`Premature end-of-call-report (endedReason=${endedReason}); awaiting the final report`);
  }

  const call = (msg.call ?? {}) as Record<string, unknown>;
  const callId = String(call.id ?? msg.callId ?? '');
  if (!callId) throw new Error('VAPI webhook missing call id');

  const artifact = (msg.artifact ?? {}) as Record<string, unknown>;
  const transcript = normalizeTranscript(artifact.messages ?? msg.messages);
  const { outcome, reason } = deriveOutcome(msg);

  return { type: 'end-of-call-report', callId, transcript, outcome, reason };
}
