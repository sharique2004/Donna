import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from '../src/server.js';
import { VapiVoice, CALL_REPORT_GRACE_MS } from '../src/core/voice/vapi.js';
import { buildInboundAssistant } from '../src/core/voice/inbound.js';
import { ENV } from '../src/config.js';
import type { MemoryStore } from '../src/core/memory/store.js';
import type { LlmClient } from '../src/core/agents/llm.js';
import type { VoiceProvider } from '../src/core/voice/caller.js';
import type {
  AgentConfig, CallRecord, Donation, DonationItem, HistoryEvent, Recipient,
} from '../src/core/types.js';
import { makeCallStoreParts } from './support/callStore.js';

/**
 * The startCall → webhook → dispatch-machine round trip.
 *
 * This is the seam that was dead once: placeCall parked a promise in vapi.ts's
 * module-scoped `pending` map, and the route was the only thing that could
 * resolve it. Unit-testing either half in isolation is what let it ship
 * disconnected, so these tests still drive both ends against the real modules —
 * no mock of vapi.js.
 *
 * What changed is where the outcome lands. There is no promise to resolve any
 * more: startCall returns a call id, the id is persisted as a CallRecord, and
 * the webhook looks it up and drives the machine. So instead of awaiting the
 * placeCall promise, these tests assert on the CallAttempt the machine wrote
 * onto the item — the same outcome, observed where it now lives.
 */

const RECIPIENT: Recipient = {
  id: 'rec-bayview-hub', name: 'Bayview Community Food Hub', type: 'pantry' as const,
  leadContact: 'Denise Carter', phone: '+14155550101',
  lat: 0, lng: 0, infrastructure: [], accepts: [], rejects: [],
  typicalWeeklyVolumeLbs: 100, receivedRecentLbs: 0,
};
const OFFER = { itemId: 'i', recipientId: 'rec-bayview-hub', script: 'Hi from Donna', summary: 'x' };
const ITEM: DonationItem = {
  id: 'i', donationId: 'd', item: 'strawberries', qtyLbs: 40,
  category: 'fresh_produce' as const,
  hoursToSpoil: 48, needsRefrigeration: true, status: 'pending' as const, attempts: [],
};

const CONFIG: AgentConfig = {
  weights: { feasibility: 0.3, coldchain: 0.15, capacity: 0.2, equity: 0.2, prefs: 0.15 },
  autopilot: true,
  avgSpeedMph: 30,
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

interface Harness {
  store: MemoryStore;
  calls: Map<string, CallRecord>;
  history: HistoryEvent[];
  item(): DonationItem;
  request(body: unknown, headers?: Record<string, string>): Promise<Response>;
  /** Place a real VapiVoice call against a stubbed VAPI and persist its CallRecord. */
  place(callId: string): Promise<void>;
}

/**
 * A store holding one donation whose single item has already been shortlisted to
 * RECIPIENT — the state the machine would be in with a call out to them.
 */
function harness(): Harness {
  const parts = makeCallStoreParts();
  // `attempts: []` fresh per harness — spreading ITEM would share one array
  // across every test in the file.
  const item: DonationItem = {
    ...ITEM, attempts: [], candidateRecipientIds: [RECIPIENT.id], candidateIndex: 0,
  };
  const donation: Donation = {
    id: 'd', sourceChannel: 'voice', sourceContact: '+14155550142',
    receivedAt: new Date().toISOString(), rawText: 'raw', status: 'dispatching',
    donorName: 'Marcus', itemCursor: 0, items: [item],
  };
  const donations = new Map<string, Donation>([['d', donation]]);
  const history: HistoryEvent[] = [];

  const store: MemoryStore = {
    ...parts,
    async init() {},
    async saveDonation(d) { donations.set(d.id, d); },
    async getDonation(id) { return donations.get(id) ?? null; },
    async listDonations() { return [...donations.values()]; },
    async listRecipients() { return [RECIPIENT]; },
    async getRecipient(id) { return id === RECIPIENT.id ? RECIPIENT : null; },
    async updateRecipient() { throw new Error('not used'); },
    async addHistory(e) { history.push(e); },
    async listHistory(rid) { return rid ? history.filter((h) => h.recipientId === rid) : history; },
    async creditReceived() {},
    async getConfig() { return CONFIG; },
    async setConfig() { return CONFIG; },
    async reset() {},
  };

  const llm: LlmClient = { async complete() { return ''; } };
  // The webhook must never dial: this item's shortlist has exactly one name on
  // it, so any startCall here means the machine advanced when it shouldn't have.
  const voice: VoiceProvider = {
    async startCall() { throw new Error('the webhook must not place a call in these tests'); },
  };
  const app = createServer({ store, llm, voice });

  return {
    store,
    calls: parts.calls,
    history,
    item: () => donations.get('d')!.items[0],
    async request(body, headers = {}) {
      return app.request('/api/vapi/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    },
    async place(callId) {
      vi.stubGlobal('fetch', async () => ({
        ok: true, json: async () => ({ id: callId }),
      } as unknown as Response));
      const id = await new VapiVoice().startCall(OFFER, RECIPIENT, ITEM);
      expect(id).toBe(callId);
      // What the machine does after a successful startCall: persist the call so a
      // later, unrelated invocation can correlate the report back to this item.
      await store.saveCall({
        callId: id, donationId: 'd', itemId: 'i', recipientId: RECIPIENT.id,
        candidateIndex: 0, placedAt: new Date().toISOString(),
      });
    },
  };
}

const LIVE_ENV = {
  voiceProvider: 'vapi', vapiApiKey: 'k', vapiPhoneNumberId: 'p',
  publicWebhookUrl: 'https://example.test', vapiWebhookSecret: '',
};

describe('VAPI webhook → dispatch machine round trip', () => {
  const saved = { ...ENV };
  afterEach(() => {
    Object.assign(ENV, saved);
    vi.unstubAllGlobals();
  });

  it('records the reported outcome onto the item that placed the call', async () => {
    Object.assign(ENV, LIVE_ENV);
    const h = harness();
    await h.place('call_round_trip');

    const res = await h.request(report('call_round_trip'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, matched: true });

    // The outcome the call was placed for. Without the route driving the machine
    // this never lands anywhere and the item sits at `dialing` until the sweep
    // writes it off as no_answer.
    const attempt = h.item().attempts[0];
    expect(attempt.outcome).toBe('accepted');
    expect(attempt.simulated).toBe(false);
    expect(attempt.recipientId).toBe('rec-bayview-hub');
    expect(attempt.transcript).toEqual([
      { speaker: 'agent', text: 'Hi from Donna' },
      { speaker: 'recipient', text: 'Yes, we can take them.' },
    ]);
    expect(h.item().status).toBe('matched');
  });

  it('carries a declined outcome and its reason through to the attempt', async () => {
    Object.assign(ENV, LIVE_ENV);
    const h = harness();
    await h.place('call_declined');

    await h.request(report('call_declined', {
      analysis: { successEvaluation: false, summary: 'overstocked on produce' },
    }));

    const attempt = h.item().attempts[0];
    expect(attempt.outcome).toBe('declined');
    expect(attempt.reason).toBe('overstocked on produce');
    // shortlist exhausted (one name), so the item is written off — not left open
    expect(h.item().status).toBe('unplaceable');
  });

  it('a duplicate report is a no-op: one attempt, recorded once', async () => {
    // VAPI retries and re-sends; on a serverless runtime the duplicate may not
    // even reach the same instance. claimCall is what makes this safe.
    Object.assign(ENV, LIVE_ENV);
    const h = harness();
    await h.place('call_dup');

    expect(await (await h.request(report('call_dup'))).json()).toMatchObject({ matched: true });
    expect(await (await h.request(report('call_dup'))).json()).toMatchObject({ matched: false });

    expect(h.item().attempts).toHaveLength(1);
    expect(h.history).toHaveLength(1);
  });

  it('acknowledges an unknown callId with matched:false instead of erroring', async () => {
    Object.assign(ENV, { voiceProvider: 'vapi', vapiWebhookSecret: '' });
    const res = await harness().request(report('call_never_placed'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matched: false });
  });

  it('ignores message types it does not act on with a 200', async () => {
    Object.assign(ENV, { voiceProvider: 'vapi', vapiWebhookSecret: '' });
    const res = await harness().request({ message: { type: 'status-update', call: { id: 'c' } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });
  });

  describe('X-Vapi-Secret enforcement', () => {
    it('rejects a request without the secret when one is configured', async () => {
      Object.assign(ENV, { voiceProvider: 'vapi', vapiWebhookSecret: 'shh' });
      const res = await harness().request(report('call_forged'));
      expect(res.status).toBe(401);
    });

    it('rejects a wrong secret', async () => {
      Object.assign(ENV, { voiceProvider: 'vapi', vapiWebhookSecret: 'shh' });
      const res = await harness().request(report('call_forged'), { 'X-Vapi-Secret': 'wrong' });
      expect(res.status).toBe(401);
    });

    it('accepts the configured secret', async () => {
      Object.assign(ENV, { voiceProvider: 'vapi', vapiWebhookSecret: 'shh' });
      const res = await harness().request(report('call_unknown'), { 'X-Vapi-Secret': 'shh' });
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
    Object.assign(ENV, LIVE_ENV);
    const h = harness();
    await h.place('019f6da8');

    // Premature report: must NOT resolve the call.
    const first = await h.request(PREMATURE('019f6da8'));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, ignored: true });

    // Nothing decided yet: no attempt recorded, and the call is still unclaimed
    // so the real report can still do its work.
    expect(h.item().attempts).toHaveLength(0);
    expect(h.item().status).toBe('pending');
    expect(h.calls.get('019f6da8')?.handledAt).toBeUndefined();

    // Final report carries the acceptance.
    const second = await h.request(FINAL('019f6da8'));
    expect(await second.json()).toMatchObject({ matched: true });

    expect(h.item().attempts).toHaveLength(1);
    expect(h.item().attempts[0].outcome).toBe('accepted');
    expect(h.item().status).toBe('matched');
  });

  it('still resolves a genuine no-answer, whose report is also dataless', async () => {
    // The reason the guard keys on endedReason rather than "payload is empty":
    // this report has no transcript and no analysis either, but must resolve.
    Object.assign(ENV, LIVE_ENV);
    const h = harness();
    await h.place('019f6dff');

    await h.request({
      message: {
        type: 'end-of-call-report',
        endedReason: 'customer-did-not-answer',
        call: { id: '019f6dff' },
        analysis: {},
        artifact: { transcript: '', messages: [] },
      },
    });

    const attempt = h.item().attempts[0];
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
    await new VapiVoice().startCall(OFFER, RECIPIENT, ITEM);
    return posted!;
  }

  it('points VAPI at the public webhook URL and asks for the messages we act on', async () => {
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
    // `transcript` is NOT optional here: server.ts turns it into live captions.
    // It was missing for a while, which silently meant the stage dashboard could
    // only ever show an inbound donor call — never the outbound pantry call.
    expect(assistant.serverMessages).toEqual(['end-of-call-report', 'transcript']);
  });

  it('asks for the same server messages on both assistants', async () => {
    // The inbound and outbound assistants are built in different files, and they
    // drifted once already. Anything server.ts handles must be requested by both,
    // or the feature works on one kind of call and silently not the other.
    Object.assign(ENV, {
      vapiApiKey: 'k', vapiPhoneNumberId: 'p',
      publicWebhookUrl: 'https://abc.ngrok.io', vapiWebhookSecret: 'shh',
    });
    const outbound = await capturePostedAssistant();
    const inbound = buildInboundAssistant() as { serverMessages?: string[] };
    expect(new Set(inbound.serverMessages)).toEqual(new Set(outbound.serverMessages));
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
    // The backstop must outlast the call, or a long conversation is swept as
    // no_answer while it is still connected — and dispatch dials the next
    // pantry with the same item still live on the first call.
    Object.assign(ENV, {
      vapiApiKey: 'k', vapiPhoneNumberId: 'p', publicWebhookUrl: 'https://abc.ngrok.io',
    });
    const assistant = await capturePostedAssistant();
    expect(assistant.maxDurationSeconds).toBe(300);
    expect(assistant.maxDurationSeconds * 1000).toBeLessThan(CALL_REPORT_GRACE_MS);
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
