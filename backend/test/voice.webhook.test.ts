import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from '../src/server.js';
import { VapiVoice } from '../src/core/voice/vapi.js';
import { buildInboundAssistant } from '../src/core/voice/inbound.js';
import { ENV } from '../src/config.js';
import type { MemoryStore } from '../src/core/memory/store.js';
import type { CallAttempt } from '../src/core/types.js';

/**
 * The placeCall → webhook → resolveCall round trip.
 *
 * This is the seam that was dead: placeCall parks a promise in vapi.ts's
 * module-scoped `pending` map, and the route is the only thing that can resolve
 * it. Unit-testing either half in isolation is what let it ship disconnected,
 * so these tests drive both ends against the real modules — no mock of vapi.js.
 */

const RECIPIENT = {
  id: 'rec-bayview-hub', name: 'Bayview Community Food Hub', type: 'pantry' as const,
  leadContact: 'Denise Carter', phone: '+14155550101',
  lat: 0, lng: 0, infrastructure: [], accepts: [], rejects: [],
  typicalWeeklyVolumeLbs: 100, receivedRecentLbs: 0,
};
const OFFER = { itemId: 'i', recipientId: 'rec-bayview-hub', script: 'Hi from Donna', summary: 'x' };
const ITEM = {
  id: 'i', donationId: 'd', item: 'strawberries', qtyLbs: 40,
  category: 'fresh_produce' as const,
  hoursToSpoil: 48, needsRefrigeration: true, status: 'pending' as const, attempts: [],
};

function report(callId: string, over: Record<string, unknown> = {}) {
  return {
    message: {
      type: 'end-of-call-report',
      endedReason: 'hangup',
      call: { id: callId },
      analysis: { successEvaluation: true, summary: 'They accepted the strawberries.' },
      artifact: {
        messages: [
          { role: 'assistant', message: 'Hi from Donna' },
          { role: 'user', message: 'Yes, we can take them.' },
        ],
      },
      ...over,
    },
  };
}

const store = { listRecipients: async () => [], listHistory: async () => [] } as unknown as MemoryStore;
const app = () => createServer({ store, llm: {} as never, voice: {} as never });

function post(body: unknown, headers: Record<string, string> = {}) {
  return app().request('/api/vapi/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Place a call against a stubbed VAPI, returning the awaitable dispatch promise. */
function placeStubbedCall(callId: string): Promise<CallAttempt> {
  vi.stubGlobal('fetch', async () => ({
    ok: true, json: async () => ({ id: callId }),
  } as unknown as Response));
  return new VapiVoice().placeCall(OFFER, RECIPIENT, ITEM);
}

describe('VAPI webhook → resolveCall round trip', () => {
  const saved = { ...ENV };
  afterEach(() => {
    Object.assign(ENV, saved);
    vi.unstubAllGlobals();
  });

  it('resolves the pending placeCall promise with the reported outcome', async () => {
    Object.assign(ENV, {
      voiceProvider: 'vapi', vapiApiKey: 'k', vapiPhoneNumberId: 'p',
      publicWebhookUrl: 'https://example.test', vapiWebhookSecret: '',
    });

    const call = placeStubbedCall('call_round_trip');
    const res = await post(report('call_round_trip'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, matched: true });

    // The promise dispatchItem awaits now completes — without the route calling
    // resolveCall this hangs until the 90s timeout and reports no_answer.
    const attempt = await call;
    expect(attempt.outcome).toBe('accepted');
    expect(attempt.simulated).toBe(false);
    expect(attempt.recipientId).toBe('rec-bayview-hub');
    expect(attempt.transcript).toEqual([
      { speaker: 'agent', text: 'Hi from Donna' },
      { speaker: 'recipient', text: 'Yes, we can take them.' },
    ]);
  });

  it('carries a declined outcome and its reason back to the caller', async () => {
    Object.assign(ENV, {
      voiceProvider: 'vapi', vapiApiKey: 'k', vapiPhoneNumberId: 'p',
      publicWebhookUrl: 'https://example.test', vapiWebhookSecret: '',
    });

    const call = placeStubbedCall('call_declined');
    await post(report('call_declined', {
      analysis: { successEvaluation: false, summary: 'overstocked on produce' },
    }));

    const attempt = await call;
    expect(attempt.outcome).toBe('declined');
    expect(attempt.reason).toBe('overstocked on produce');
  });

  it('acknowledges an unknown callId with matched:false instead of erroring', async () => {
    Object.assign(ENV, { voiceProvider: 'vapi', vapiWebhookSecret: '' });
    const res = await post(report('call_never_placed'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matched: false });
  });

  it('ignores message types it does not act on with a 200', async () => {
    Object.assign(ENV, { voiceProvider: 'vapi', vapiWebhookSecret: '' });
    const res = await post({ message: { type: 'status-update', call: { id: 'c' } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });
  });

  describe('X-Vapi-Secret enforcement', () => {
    it('rejects a request without the secret when one is configured', async () => {
      Object.assign(ENV, { voiceProvider: 'vapi', vapiWebhookSecret: 'shh' });
      const res = await post(report('call_forged'));
      expect(res.status).toBe(401);
    });

    it('rejects a wrong secret', async () => {
      Object.assign(ENV, { voiceProvider: 'vapi', vapiWebhookSecret: 'shh' });
      const res = await post(report('call_forged'), { 'X-Vapi-Secret': 'wrong' });
      expect(res.status).toBe(401);
    });

    it('accepts the configured secret', async () => {
      Object.assign(ENV, { voiceProvider: 'vapi', vapiWebhookSecret: 'shh' });
      const res = await post(report('call_unknown'), { 'X-Vapi-Secret': 'shh' });
      expect(res.status).toBe(200);
    });
  });
});

/**
 * Regression — the two-report race, captured live on 2026-07-16.
 *
 * Both bodies below are the real payloads VAPI posted for call 019f6da8, in the
 * order they arrived. The recipient accepted out loud; the premature report won
 * the race and the pipeline recorded `declined` and dialed the next pantry.
 */
describe('two end-of-call-report race (live capture)', () => {
  const saved = { ...ENV };
  afterEach(() => {
    Object.assign(ENV, saved);
    vi.unstubAllGlobals();
  });

  const PREMATURE = (callId: string) => ({
    message: {
      type: 'end-of-call-report',
      endedReason: 'call.in-progress.twilio-completed-call',
      call: { id: callId },
      analysis: {},
      artifact: { transcript: '', messages: [] },
    },
  });

  const FINAL = (callId: string) => ({
    message: {
      type: 'end-of-call-report',
      endedReason: 'customer-ended-call',
      call: { id: callId },
      analysis: {
        summary: 'Denise confirmed she could take the strawberries today.',
        successEvaluation: 'true',
      },
      artifact: {
        transcript:
          'AI: Hi, Denise. I have 5000 pounds of fresh strawberries...\n' +
          'User: Yes. I will be able to take them today.',
        messages: [
          { role: 'assistant', message: 'Hi, Denise. I have 5000 pounds of fresh strawberries...' },
          { role: 'user', message: 'Yes. I will be able to take them today.' },
        ],
      },
    },
  });

  it('ignores the premature report and accepts on the final one', async () => {
    Object.assign(ENV, {
      voiceProvider: 'vapi', vapiApiKey: 'k', vapiPhoneNumberId: 'p',
      publicWebhookUrl: 'https://example.test', vapiWebhookSecret: '',
    });

    const call = placeStubbedCall('019f6da8');

    // Premature report: must NOT resolve the call.
    const first = await post(PREMATURE('019f6da8'));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, ignored: true });

    // Still pending — nothing should have been decided yet.
    const settled = await Promise.race([
      call.then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('pending'), 20)),
    ]);
    expect(settled).toBe('pending');

    // Final report carries the acceptance.
    const second = await post(FINAL('019f6da8'));
    expect(await second.json()).toMatchObject({ matched: true });

    const attempt = await call;
    expect(attempt.outcome).toBe('accepted');
  });

  it('still resolves a genuine no-answer, whose report is also dataless', async () => {
    // The reason the guard keys on endedReason rather than "payload is empty":
    // this report has no transcript and no analysis either, but must resolve.
    Object.assign(ENV, {
      voiceProvider: 'vapi', vapiApiKey: 'k', vapiPhoneNumberId: 'p',
      publicWebhookUrl: 'https://example.test', vapiWebhookSecret: '',
    });

    const call = placeStubbedCall('019f6dff');
    await post({
      message: {
        type: 'end-of-call-report',
        endedReason: 'customer-did-not-answer',
        call: { id: '019f6dff' },
        analysis: {},
        artifact: { transcript: '', messages: [] },
      },
    });

    const attempt = await call;
    expect(attempt.outcome).toBe('no_answer');
    expect(attempt.reason).toBe('customer-did-not-answer');
  });
});

describe('assistant server block', () => {
  const saved = { ...ENV };
  afterEach(() => {
    Object.assign(ENV, saved);
    vi.unstubAllGlobals();
  });

  /** Capture the assistant VAPI is asked to run. */
  async function capturePostedAssistant(): Promise<Record<string, any>> {
    let posted: Record<string, any> | undefined;
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      posted = JSON.parse(init.body).assistant;
      return { ok: true, json: async () => ({ id: 'call_assistant' }) } as unknown as Response;
    });
    await Promise.race([
      new VapiVoice().placeCall(OFFER, RECIPIENT, ITEM),
      new Promise((r) => setTimeout(r, 0)),
    ]);
    return posted!;
  }

  it('points VAPI at the public webhook URL and narrows serverMessages', async () => {
    Object.assign(ENV, {
      vapiApiKey: 'k', vapiPhoneNumberId: 'p',
      publicWebhookUrl: 'https://abc.ngrok.io', vapiWebhookSecret: 'shh',
    });
    const assistant = await capturePostedAssistant();
    expect(assistant.server).toEqual({
      url: 'https://abc.ngrok.io/api/vapi/webhook',
      timeoutSeconds: 20,
      secret: 'shh',
    });
    expect(assistant.serverMessages).toEqual(['end-of-call-report']);
  });

  it('talks on Gemini, not OpenAI', async () => {
    // The pitch says Gemini; the voice should be Gemini. Pinned because the
    // provider is easy to change back by accident and the only place it shows
    // up is on a live phone call.
    Object.assign(ENV, {
      vapiApiKey: 'k', vapiPhoneNumberId: 'p', publicWebhookUrl: 'https://abc.ngrok.io',
    });
    const assistant = await capturePostedAssistant();
    expect(assistant.model.provider).toBe('google');
    expect(assistant.model.model).toBe('gemini-2.5-flash');
  });

  it('uses the same in-call model for the inbound donor assistant', async () => {
    // A donor and a pantry hearing different models would be a strange bug to
    // find by ear.
    const inbound = buildInboundAssistant();
    expect(inbound.model.provider).toBe('google');
    expect(inbound.model.model).toBe('gemini-2.5-flash');
  });

  it('caps call duration below our own report backstop', async () => {
    // The backstop must outlast the call, or a long conversation resolves as
    // no_answer while it is still connected — and dispatch dials the next
    // pantry with the same item still live on the first call.
    Object.assign(ENV, {
      vapiApiKey: 'k', vapiPhoneNumberId: 'p', publicWebhookUrl: 'https://abc.ngrok.io',
    });
    const assistant = await capturePostedAssistant();
    expect(assistant.maxDurationSeconds).toBe(300);
  });

  it('omits the secret when none is configured', async () => {
    Object.assign(ENV, {
      vapiApiKey: 'k', vapiPhoneNumberId: 'p',
      publicWebhookUrl: 'https://abc.ngrok.io', vapiWebhookSecret: '',
    });
    const assistant = await capturePostedAssistant();
    expect(assistant.server.secret).toBeUndefined();
  });

  it('omits the server block entirely when PUBLIC_WEBHOOK_URL is unset', async () => {
    Object.assign(ENV, {
      vapiApiKey: 'k', vapiPhoneNumberId: 'p', publicWebhookUrl: '', vapiWebhookSecret: '',
    });
    const assistant = await capturePostedAssistant();
    expect(assistant.server).toBeUndefined();
    expect(assistant.serverMessages).toBeUndefined();
  });
});
