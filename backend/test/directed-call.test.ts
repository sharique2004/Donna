import { describe, it, expect } from 'vitest';
import type {
  Donation, DonationItem, Recipient, HistoryEvent, AgentConfig, OfferDraft,
  CallAttempt,
} from '../src/core/types.js';
import type { MemoryStore } from '../src/core/memory/store.js';
import type { LlmClient } from '../src/core/agents/llm.js';
import type { VoiceProvider } from '../src/core/voice/caller.js';
import { createServer } from '../src/server.js';

// Integration tests for §G.3 directed / manual single-recipient calls. These run
// the REAL pipeline (draftOffer + composeDonorMessage degrade to deterministic
// templates with a stub LLM, so zero env vars are needed) against an in-memory
// store and a controllable voice provider.

const CONFIG: AgentConfig = {
  weights: { feasibility: 0.3, coldchain: 0.15, capacity: 0.2, equity: 0.2, prefs: 0.15 },
  autopilot: true,
  avgSpeedMph: 30,
};

function recipient(id: string, name: string): Recipient {
  return {
    id, name, type: 'pantry', leadContact: `Lead ${name}`, phone: '+14155550100',
    lat: 37.77, lng: -122.41, infrastructure: ['fridge'],
    accepts: ['fresh_produce', 'baked'], rejects: [],
    typicalWeeklyVolumeLbs: 1000, receivedRecentLbs: 0,
  };
}

function item(id: string, donationId: string, name = 'strawberries'): DonationItem {
  return {
    id, donationId, item: name, qtyLbs: 500, category: 'fresh_produce',
    hoursToSpoil: 48, needsRefrigeration: true, status: 'pending', attempts: [],
  };
}

function donation(id: string, items: DonationItem[]): Donation {
  return {
    id, sourceChannel: 'voice', sourceContact: '+14155550142',
    receivedAt: new Date().toISOString(), rawText: 'raw', status: 'scored',
    donorName: 'Marcus', items,
  };
}

interface Harness {
  store: MemoryStore;
  history: HistoryEvent[];
  credits: Array<{ recipientId: string; lbs: number }>;
  donations: Map<string, Donation>;
}

function makeStore(
  seedDonations: Donation[],
  recipients: Recipient[],
): Harness {
  const donations = new Map<string, Donation>();
  for (const d of seedDonations) donations.set(d.id, d);
  const history: HistoryEvent[] = [];
  const credits: Array<{ recipientId: string; lbs: number }> = [];
  const store: MemoryStore = {
    async init() {},
    async saveDonation(d) { donations.set(d.id, d); },
    async getDonation(id) { return donations.get(id) ?? null; },
    async listDonations() { return [...donations.values()]; },
    async listRecipients() { return recipients; },
    async getRecipient(id) { return recipients.find((r) => r.id === id) ?? null; },
    async updateRecipient(id, patch) {
      const r = recipients.find((x) => x.id === id)!;
      Object.assign(r, patch);
      return r;
    },
    async addHistory(e) { history.push(e); },
    async listHistory(rid) { return rid ? history.filter((h) => h.recipientId === rid) : history; },
    async creditReceived(recipientId, lbs) { credits.push({ recipientId, lbs }); },
    async getConfig() { return CONFIG; },
    async setConfig() { return CONFIG; },
    async reset() {},
  };
  return { store, history, credits, donations };
}

const stubLlm: LlmClient = { async complete() { return ''; } };

function voiceReturning(outcome: CallAttempt['outcome'], reason?: string): VoiceProvider {
  return {
    async placeCall(_offer: OfferDraft, r: Recipient): Promise<CallAttempt> {
      return {
        recipientId: r.id, recipientName: r.name, outcome,
        ...(reason ? { reason } : {}),
        transcript: [{ speaker: 'agent', text: 'hi' }, { speaker: 'recipient', text: 'ok' }],
        at: new Date().toISOString(), simulated: true,
      };
    },
  };
}

describe('POST /api/items/:itemId/call/:recipientId — directed agent call', () => {
  it('accepted ⇒ item matched, recipient credited, history recorded, returns {item, attempt}', async () => {
    const it1 = item('i1', 'd1');
    const h = makeStore([donation('d1', [it1])], [recipient('r1', 'Chinatown Pantry')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: voiceReturning('accepted') });

    const res = await app.request('/api/items/i1/call/r1', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: DonationItem; attempt: CallAttempt };

    expect(body.item.status).toBe('matched');
    expect(body.item.matchedRecipientId).toBe('r1');
    expect(body.item.attempts).toHaveLength(1);
    expect(body.attempt.outcome).toBe('accepted');
    expect(body.attempt.recipientName).toBe('Chinatown Pantry');
    // credited + history
    expect(h.credits).toEqual([{ recipientId: 'r1', lbs: 500 }]);
    expect(h.history).toHaveLength(1);
    expect(h.history[0]).toMatchObject({ recipientId: 'r1', itemId: 'i1', outcome: 'accepted' });
    // persisted
    expect(h.donations.get('d1')?.items[0].status).toBe('matched');
  });

  it('declined ⇒ item stays pending, history records the reason (feeds 7-day prefs window)', async () => {
    const it1 = item('i1', 'd1', 'bread');
    it1.category = 'baked';
    const h = makeStore([donation('d1', [it1])], [recipient('r1', 'Harbor Pantry')]);
    const app = createServer({
      store: h.store, llm: stubLlm,
      voice: voiceReturning('declined', 'still overstocked on baked'),
    });

    const res = await app.request('/api/items/i1/call/r1', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: DonationItem; attempt: CallAttempt };

    expect(body.item.status).toBe('pending');
    expect(body.attempt.outcome).toBe('declined');
    expect(h.credits).toHaveLength(0);
    // history recorded with the decline reason: the prefs term picks this up
    // for calls placed within the next 7 days.
    expect(h.history).toHaveLength(1);
    const now = Date.now();
    const at = new Date(h.history[0].at).getTime();
    expect(now - at).toBeLessThan(7 * 24 * 3600 * 1000);
    expect(h.history[0]).toMatchObject({ outcome: 'declined', reason: 'still overstocked on baked' });
    // donation NOT resolved — item still open
    expect(h.donations.get('d1')?.status).not.toBe('resolved');
  });

  it('404 for unknown item, 404 for unknown recipient', async () => {
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'A')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: voiceReturning('accepted') });

    const noItem = await app.request('/api/items/ghost/call/r1', { method: 'POST' });
    expect(noItem.status).toBe(404);
    const noRecip = await app.request('/api/items/i1/call/ghost', { method: 'POST' });
    expect(noRecip.status).toBe(404);
  });

  it('409 when the item is not pending', async () => {
    const it1 = item('i1', 'd1');
    it1.status = 'matched';
    const h = makeStore([donation('d1', [it1])], [recipient('r1', 'A')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: voiceReturning('accepted') });

    const res = await app.request('/api/items/i1/call/r1', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('accepting the LAST pending item auto-resolves the donation with a donor callback', async () => {
    // one already-matched item + one pending; closing the pending one resolves it.
    const matched = { ...item('i1', 'd1'), status: 'matched' as const, matchedRecipientId: 'r0' };
    const pending = item('i2', 'd1', 'bread');
    const h = makeStore([donation('d1', [matched, pending])], [recipient('r1', 'Mission Pantry')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: voiceReturning('accepted') });

    const res = await app.request('/api/items/i2/call/r1', { method: 'POST' });
    expect(res.status).toBe(200);

    const d = h.donations.get('d1')!;
    expect(d.status).toBe('resolved');
    expect(d.donorMessage && d.donorMessage.length).toBeGreaterThan(0);
  });
});

describe('POST /api/items/:itemId/manual/:recipientId — human-logged call', () => {
  it('manual accepted ⇒ CallAttempt round-trips manual:true, simulated:false, notes→transcript; matches + credits', async () => {
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'Bayview Pantry')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: voiceReturning('no_answer') });

    const res = await app.request('/api/items/i1/manual/r1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'accepted', notes: 'Spoke to Rosa; truck comes at 3pm.' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: DonationItem; attempt: CallAttempt };

    expect(body.attempt.manual).toBe(true);
    expect(body.attempt.simulated).toBe(false);
    expect(body.attempt.transcript).toEqual([
      { speaker: 'agent', text: 'Spoke to Rosa; truck comes at 3pm.' },
    ]);
    expect(body.item.status).toBe('matched');
    expect(h.credits).toEqual([{ recipientId: 'r1', lbs: 500 }]);
    // round-trips through the DB with the manual flag intact
    expect(h.donations.get('d1')?.items[0].attempts[0].manual).toBe(true);
  });

  it('manual declined ⇒ history recorded, item stays pending, empty transcript when no notes', async () => {
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'A')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: voiceReturning('accepted') });

    const res = await app.request('/api/items/i1/manual/r1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'declined', reason: 'no capacity this week' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: DonationItem; attempt: CallAttempt };

    expect(body.attempt.manual).toBe(true);
    expect(body.attempt.transcript).toEqual([]);
    expect(body.item.status).toBe('pending');
    expect(h.history[0]).toMatchObject({ outcome: 'declined', reason: 'no capacity this week' });
    expect(h.credits).toHaveLength(0);
  });

  it('400 on an invalid outcome; 409 on a non-pending item; 404 on unknown ids', async () => {
    const matched = { ...item('i1', 'd1'), status: 'matched' as const };
    const pending = item('i2', 'd1');
    const h = makeStore([donation('d1', [matched, pending])], [recipient('r1', 'A')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: voiceReturning('accepted') });

    const bad = await app.request('/api/items/i2/manual/r1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'maybe' }),
    });
    expect(bad.status).toBe(400);

    const conflict = await app.request('/api/items/i1/manual/r1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'accepted' }),
    });
    expect(conflict.status).toBe(409);

    const noItem = await app.request('/api/items/ghost/manual/r1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'accepted' }),
    });
    expect(noItem.status).toBe(404);
  });

  it('a manual call closing the last pending item auto-resolves the donation identically', async () => {
    const h = makeStore([donation('d1', [item('i1', 'd1')])], [recipient('r1', 'Excelsior Pantry')]);
    const app = createServer({ store: h.store, llm: stubLlm, voice: voiceReturning('no_answer') });

    const res = await app.request('/api/items/i1/manual/r1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'accepted', notes: 'confirmed' }),
    });
    expect(res.status).toBe(200);

    const d = h.donations.get('d1')!;
    expect(d.status).toBe('resolved');
    expect(d.donorMessage && d.donorMessage.length).toBeGreaterThan(0);
  });
});
