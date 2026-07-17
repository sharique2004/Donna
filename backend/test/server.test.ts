import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Donation, DonationItem, AgentConfig, RankedRecipient, ManagerReply,
  Recipient, HistoryEvent,
} from '../src/core/types.js';
import type { MemoryStore } from '../src/core/memory/store.js';
import type { LlmClient } from '../src/core/agents/llm.js';
import type { VoiceProvider } from '../src/core/voice/caller.js';
import { makeCallStoreParts } from './support/callStore.js';

// --- module mocks (these modules are stubs during parallel Phase 2) ---------
const ingestDonation = vi.fn();
const dispatchDonation = vi.fn();
const rankItem = vi.fn();
vi.mock('../src/core/pipeline.js', () => ({
  ingestDonation: (...a: unknown[]) => ingestDonation(...a),
  dispatchDonation: (...a: unknown[]) => dispatchDonation(...a),
  rankItem: (...a: unknown[]) => rankItem(...a),
}));

const managerChat = vi.fn();
vi.mock('../src/core/agents/manager.js', () => ({
  managerChat: (...a: unknown[]) => managerChat(...a),
}));

const explainRanking = vi.fn();
vi.mock('../src/core/scoring/explain.js', () => ({
  explainRanking: (...a: unknown[]) => explainRanking(...a),
}));

const simulateAB = vi.fn();
vi.mock('../src/core/scoring/equity.js', () => ({
  simulateAB: (...a: unknown[]) => simulateAB(...a),
}));

// Imported AFTER mocks are registered.
import { createServer } from '../src/server.js';

// --- fixtures ----------------------------------------------------------------
const CONFIG: AgentConfig = {
  weights: { feasibility: 0.3, coldchain: 0.15, capacity: 0.2, equity: 0.2, prefs: 0.15 },
  autopilot: false,
  avgSpeedMph: 30,
};

const item = (id: string): DonationItem => ({
  id,
  donationId: 'd1',
  item: 'strawberries',
  qtyLbs: 5000,
  category: 'fresh_produce',
  hoursToSpoil: 48,
  needsRefrigeration: true,
  status: 'pending',
  attempts: [],
});

const donation = (id: string, items: DonationItem[]): Donation => ({
  id,
  sourceChannel: 'voice',
  sourceContact: '+14155550142',
  receivedAt: new Date().toISOString(),
  rawText: 'canned scenario',
  status: 'scored',
  items,
});

function makeStore(donations: Donation[] = []): MemoryStore {
  return {
    ...makeCallStoreParts(),
    init: vi.fn(async () => {}),
    saveDonation: vi.fn(async () => {}),
    getDonation: vi.fn(async (id: string) => donations.find((d) => d.id === id) ?? null),
    listDonations: vi.fn(async () => donations),
    listRecipients: vi.fn(async () => [] as Recipient[]),
    getRecipient: vi.fn(async () => null),
    updateRecipient: vi.fn(async () => ({}) as Recipient),
    addHistory: vi.fn(async () => {}),
    listHistory: vi.fn(async () => [] as HistoryEvent[]),
    creditReceived: vi.fn(async () => {}),
    getConfig: vi.fn(async () => CONFIG),
    setConfig: vi.fn(async (patch) => ({ ...CONFIG, ...patch }) as AgentConfig),
    reset: vi.fn(async () => {}),
  };
}

const stubLlm: LlmClient = { complete: vi.fn(async () => '') };
// placeCall (awaits the whole call) → startCall (dials, returns the id).
const stubVoice: VoiceProvider = { startCall: vi.fn(async () => 'call_stub') };

function server(store: MemoryStore) {
  return createServer({ store, llm: stubLlm, voice: stubVoice });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- tests -------------------------------------------------------------------
describe('GET /api/health', () => {
  it('reports mode with all three providers', async () => {
    const app = server(makeStore());
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.mode).toHaveProperty('llm');
    expect(body.mode).toHaveProperty('db');
    expect(body.mode).toHaveProperty('voice');
  });
});

describe('POST /api/demo/canned', () => {
  it('ingests the canned scenario and returns enriched {donation, rankings} 200', async () => {
    const d = donation('d1', [item('i1'), item('i2')]);
    ingestDonation.mockResolvedValue(d);
    rankItem.mockResolvedValue([] as RankedRecipient[]);
    const app = server(makeStore([d]));

    const res = await app.request('/api/demo/canned', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.donation.id).toBe('d1');
    expect(Object.keys(body.rankings)).toEqual(['i1', 'i2']);
    expect(ingestDonation).toHaveBeenCalledOnce();
  });

  it('degrades a per-item ranking failure into warnings, not a 5xx', async () => {
    const d = donation('d1', [item('i1')]);
    ingestDonation.mockResolvedValue(d);
    rankItem.mockRejectedValue(new Error('scoring exploded'));
    const app = server(makeStore([d]));

    const res = await app.request('/api/demo/canned', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.rankings.i1).toEqual([]);
    expect(body.warnings[0]).toContain('i1');
  });
});

describe('GET /api/calls (§D.5)', () => {
  it('flattens every attempt across donations, newest first', async () => {
    const older: DonationItem = {
      ...item('i1'),
      attempts: [{
        recipientId: 'rA', recipientName: 'Harbor Pantry', outcome: 'declined',
        reason: 'still overstocked on baked', transcript: [],
        at: '2026-07-16T10:00:00.000Z', simulated: true,
      }],
    };
    const newer: DonationItem = {
      ...item('i2'),
      attempts: [{
        recipientId: 'rB', recipientName: 'Chinatown Pantry', outcome: 'accepted',
        transcript: [], at: '2026-07-16T12:00:00.000Z', simulated: true,
      }],
    };
    const d1 = donation('d1', [older]);
    const d2 = donation('d2', [newer]);
    const app = server(makeStore([d1, d2]));

    const res = await app.request('/api/calls');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body).toHaveLength(2);
    // newest-first
    expect(body[0].recipientName).toBe('Chinatown Pantry');
    expect(body[0].donationId).toBe('d2');
    expect(body[0].itemId).toBe('i2');
    expect(body[0].itemName).toBe('strawberries');
    expect(body[0].outcome).toBe('accepted');
    expect(body[1].donationId).toBe('d1');
    expect(body[1].outcome).toBe('declined');
  });

  it('returns an empty array when there are no attempts', async () => {
    const app = server(makeStore([donation('d1', [item('i1')])]));
    const res = await app.request('/api/calls');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('POST /api/items/:id/rank', () => {
  it('re-ranks with a weight override and returns ranked + explanation', async () => {
    const d = donation('d1', [item('i1')]);
    const ranked = [{ recipient: { id: 'r1' }, score: { total: 0.9 } }] as unknown as RankedRecipient[];
    rankItem.mockResolvedValue(ranked);
    explainRanking.mockResolvedValue('r1 wins because it has cold storage.');
    const app = server(makeStore([d]));

    const overrideWeights = { feasibility: 1, coldchain: 0, capacity: 0, equity: 0, prefs: 0 };
    const res = await app.request('/api/items/i1/rank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weights: overrideWeights }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ranked).toEqual(ranked);
    expect(body.explanation).toContain('cold storage');
    // weight override forwarded to pipeline.rankItem
    expect(rankItem).toHaveBeenCalledWith('i1', overrideWeights, expect.anything());
  });

  it('404s for an unknown item id', async () => {
    const app = server(makeStore([donation('d1', [item('i1')])]));
    const res = await app.request('/api/items/nope/rank', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBeTruthy();
  });
});

describe('POST /api/manager/chat', () => {
  it('returns a ManagerReply for a valid message', async () => {
    const reply: ManagerReply = { reply: 'Added a freezer to St. Mary\'s.', patches: [], applied: true };
    managerChat.mockResolvedValue(reply);
    const app = server(makeStore());

    const res = await app.request('/api/manager/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: "St. Mary's got a new freezer" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.applied).toBe(true);
    expect(managerChat).toHaveBeenCalledWith("St. Mary's got a new freezer", expect.anything(), stubLlm);
  });

  it('400s when message is missing', async () => {
    const app = server(makeStore());
    const res = await app.request('/api/manager/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('validation & errors', () => {
  it('POST /api/donations 400 without rawText', async () => {
    const app = server(makeStore());
    const res = await app.request('/api/donations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'voice' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/donations/:id 404 when absent', async () => {
    const app = server(makeStore());
    const res = await app.request('/api/donations/ghost');
    expect(res.status).toBe(404);
  });

  it('GET /api/equity/simulate defaults drops to 30', async () => {
    simulateAB.mockReturnValue({ drops: 30 });
    const app = server(makeStore());
    const res = await app.request('/api/equity/simulate');
    expect(res.status).toBe(200);
    expect(simulateAB).toHaveBeenCalledWith([], 30);
  });

  it('POST /api/vapi/webhook is a no-op in sim mode', async () => {
    const app = server(makeStore());
    const res = await app.request('/api/vapi/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anything: true }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ignored).toBe(true);
  });

  it('GET /api/recipients/:id returns {recipient, history} when found', async () => {
    const store = makeStore();
    (store.getRecipient as any).mockResolvedValue({ id: 'r1', name: 'Test Pantry' });
    const app = server(store);
    const res = await app.request('/api/recipients/r1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.recipient.id).toBe('r1');
    expect(Array.isArray(body.history)).toBe(true);
  });
});
