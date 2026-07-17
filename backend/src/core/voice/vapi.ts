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
 * A placed call returns a Promise that stays pending until the matching
 * end-of-call-report webhook resolves it, or a 90s timeout fires ⇒ no_answer.
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
 * Backstop for a report that never arrives at all (tunnel down, process
 * restarted mid-call, VAPI drops the webhook). It is NOT a conversation limit —
 * MAX_CALL_DURATION_S is. Deriving it from that ceiling plus a delivery buffer
 * keeps the two from drifting apart.
 *
 * This was 90s flat, which is shorter than a real conversation: observed live
 * 2026-07-16, a recipient talked for ~100s and declined, the timer fired first
 * and recorded `no_answer`, and the genuine decline arrived to find nothing
 * pending. Two harms — the decline reason never reached memory (PRD §9 learns
 * from those), and dispatch dialed the next pantry while the first call was
 * still connected, offering the same 5000 lbs to two recipients at once.
 */
const CALL_TIMEOUT_MS = (MAX_CALL_DURATION_S + 60) * 1000;

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

interface PendingCall {
  offer: OfferDraft;
  recipient: Recipient;
  item: DonationItem;
  resolve: (a: CallAttempt) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** callId → the awaiting dispatch promise. Module-scoped so the webhook route can reach it. */
const pending = new Map<string, PendingCall>();

/**
 * Where VAPI posts this call's end-of-call-report, and what it's allowed to post.
 *
 * Verified against docs.vapi.ai (2026-07): `server: { url, secret, timeoutSeconds }`
 * plus `serverMessages: [...]` on the assistant. The 2024-10-13 changelog retired
 * the older top-level `serverUrl`/`serverUrlSecret` in favour of this block.
 *
 * `serverMessages` is deliberately narrowed to the one message we act on —
 * without it VAPI also streams status-update/transcript/speech-update chatter at
 * the route for every call.
 *
 * Returns {} when PUBLIC_WEBHOOK_URL is unset, which leaves the call unable to
 * report back; placeCall warns about exactly that below.
 */
function serverBlock() {
  if (!ENV.publicWebhookUrl) return {};
  return {
    server: {
      url: `${ENV.publicWebhookUrl}/api/vapi/webhook`,
      timeoutSeconds: 20,
      ...(ENV.vapiWebhookSecret ? { secret: ENV.vapiWebhookSecret } : {}),
    },
    serverMessages: ['end-of-call-report'],
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
  async placeCall(
    offer: OfferDraft,
    recipient: Recipient,
    item: DonationItem,
  ): Promise<CallAttempt> {
    if (!ENV.vapiApiKey || !ENV.vapiPhoneNumberId) {
      throw new Error('VAPI_API_KEY and VAPI_PHONE_NUMBER_ID are required for VOICE_PROVIDER=vapi');
    }
    if (!ENV.publicWebhookUrl) {
      // Not fatal — the call still connects and a human still hears the offer —
      // but nothing can report the outcome back, so this dispatch is guaranteed
      // to burn the full 90s timeout and record no_answer whatever is said.
      console.warn(
        '[vapi] PUBLIC_WEBHOOK_URL is unset: no server block on the assistant, so ' +
          'no end-of-call-report can reach us. This call will time out after 90s ' +
          'and resolve as no_answer regardless of the recipient\'s answer.',
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

    // The promise is resolved by the end-of-call-report webhook (via resolveCall),
    // or by the 90s timeout below ⇒ no_answer.
    return new Promise<CallAttempt>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(callId);
        resolve({
          recipientId: recipient.id,
          recipientName: recipient.name,
          outcome: 'no_answer',
          reason: 'no end-of-call report within 90s',
          transcript: [{ speaker: 'agent', text: offer.script }],
          at: new Date().toISOString(),
          simulated: false,
        });
      }, CALL_TIMEOUT_MS);

      pending.set(callId, { offer, recipient, item, resolve, timer });
    });
  }
}

/**
 * Called by the /api/vapi/webhook server route. Correlates the normalized
 * report to the pending placeCall promise and completes the same path
 * dispatchItem awaits. Returns true if a pending call was matched.
 */
export function resolveCall(hook: NormalizedWebhook): boolean {
  const entry = pending.get(hook.callId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(hook.callId);
  entry.resolve({
    recipientId: entry.recipient.id,
    recipientName: entry.recipient.name,
    outcome: hook.outcome,
    reason: hook.reason,
    transcript: hook.transcript.length
      ? hook.transcript
      : [{ speaker: 'agent', text: entry.offer.script }],
    at: new Date().toISOString(),
    simulated: false,
  });
  return true;
}

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
