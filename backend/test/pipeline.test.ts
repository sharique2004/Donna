import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Donation, DonationItem, ParsedDonation, Recipient, HistoryEvent,
  AgentConfig, RankedRecipient, Weights, CallOutcome, ScoreBreakdown,
} from '../src/core/types.js';
import type { MemoryStore } from '../src/core/memory/store.js';
import type { LlmClient } from '../src/core/agents/llm.js';
import type { VoiceProvider } from '../src/core/voice/caller.js';
import { makeCallStoreParts } from './support/callStore.js';

// --- Mock the module-level collaborators (contract-first; other WPs not required) ---
vi.mock('../src/core/agents/intake.js', () => ({
  parseDonation: vi.fn(),
}));
vi.mock('../src/core/agents/callback.js', () => ({
  composeDonorMessage: vi.fn(),
}));
vi.mock('../src/core/scoring/engine.js', () => ({
  rankRecipients: vi.fn(),
}));

import { parseDonation } from '../src/core/agents/intake.js';
import { composeDonorMessage } from '../src/core/agents/callback.js';
import { rankRecipients } from '../src/core/scoring/engine.js';
import { ingestDonation, dispatchDonation, rankItem } from '../src/core/pipeline.js';

/**
 * dispatchDonation no longer drives a `dispatchItem` loop it can be caught
 * mocking — it hands off to the state machine, which places one call and returns
 * (webhooks drive the rest). Under a simulator-shaped provider there are no
 * webhooks, so the machine runs to completion synchronously and dispatchDonation's
 * return IS the final state. That is the mode these tests use, and the mocked
 * `rankRecipients` is what decides who each item's shortlist contains.
 *
 * The old `expect(dispatchItem).toHaveBeenCalledWith(...)` assertions are now
 * made against the calls the provider actually receives, which is the same
 * behaviour observed one layer further down.
 */

// --- Stub deps ---
const DEFAULT_CONFIG: AgentConfig = {
  weights: { feasibility: 0.3, coldchain: 0.15, capacity: 0.2, equity: 0.2, prefs: 0.15 },
  autopilot: true,
  avgSpeedMph: 30,
};

function makeStore(seed: Donation[] = []): MemoryStore & { saved: Donation[] } {
  const donations = new Map<string, Donation>();
  for (const d of seed) donations.set(d.id, d);
  const saved: Donation[] = [];
  const recipients: Recipient[] = [
    {
      id: 'r1', name: 'A', type: 'pantry', leadContact: 'x', phone: '+1',
      lat: 0, lng: 0, infrastructure: ['fridge'], accepts: [], rejects: [],
      typicalWeeklyVolumeLbs: 1000, receivedRecentLbs: 0,
    },
    {
      id: 'r2', name: 'B', type: 'pantry', leadContact: 'y', phone: '+1',
      lat: 0, lng: 0, infrastructure: ['fridge'], accepts: [], rejects: [],
      typicalWeeklyVolumeLbs: 1000, receivedRecentLbs: 0,
    },
  ];
  const history: HistoryEvent[] = [];
  const store: MemoryStore & { saved: Donation[] } = {
    saved,
    ...makeCallStoreParts(),
    async init() {},
    async saveDonation(d) {
      donations.set(d.id, d);
      // record a deep-ish snapshot of status for transition assertions
      saved.push({ ...d, items: d.items.map((it) => ({ ...it })) });
    },
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
    async creditReceived() {},
    async getConfig() { return DEFAULT_CONFIG; },
    async setConfig() { return DEFAULT_CONFIG; },
    async reset() {},
  };
  return store;
}

const llm: LlmClient = { async complete() { return ''; } };

/**
 * A simulator-shaped provider (startCall + synthesizeReport ⇒ no webhook), so a
 * dispatch completes inside dispatchDonation. `calls` records what was actually
 * dialed, for the assertions the dispatchItem mock used to carry.
 */
function voiceFor(outcomes: Record<string, CallOutcome> = {}): VoiceProvider & {
  calls: Array<{ itemId: string; recipientId: string }>;
} {
  const calls: Array<{ itemId: string; recipientId: string }> = [];
  let n = 0;
  return {
    calls,
    async startCall(_offer, recipient, item) {
      calls.push({ itemId: item.id, recipientId: recipient.id });
      return `sim_${++n}`;
    },
    async synthesizeReport(_offer, recipient) {
      return { outcome: outcomes[recipient.id] ?? 'accepted', transcript: [] };
    },
  };
}

const voice: VoiceProvider = voiceFor();

/** rankRecipients is mocked here, so the shortlist is whatever this returns. */
function rankedAs(recipients: Recipient[]): RankedRecipient[] {
  return recipients.map((recipient, idx) => ({
    recipient,
    score: {
      recipientId: recipient.id,
      feasibility: 1, coldchain: 1, capacity: 1, equity: 1, prefs: 1,
      total: 1 - idx * 0.1,
      driveTimeHours: 0.2, distanceMiles: 5,
    } as ScoreBreakdown,
  }));
}

beforeEach(() => {
  vi.mocked(parseDonation).mockReset();
  vi.mocked(composeDonorMessage).mockReset();
  vi.mocked(rankRecipients).mockReset();
});

describe('ingestDonation', () => {
  it('parses, builds ids, stores, and sets status to scored', async () => {
    const parsed: ParsedDonation = {
      donorName: 'Marcus', pickupLocation: 'Dock 12',
      pickupLat: 37.7455, pickupLng: -122.3934,
      items: [
        { item: 'strawberries', qtyLbs: 5000, category: 'fresh_produce', hoursToSpoil: 48, needsRefrigeration: true },
        { item: 'beans', qtyLbs: 200, category: 'canned', hoursToSpoil: 2160, needsRefrigeration: false },
      ],
    };
    vi.mocked(parseDonation).mockResolvedValue(parsed);
    const store = makeStore();

    const donation = await ingestDonation(
      { channel: 'voice', contact: '+14155550100', rawText: 'hello' },
      { store, llm, voice, config: DEFAULT_CONFIG },
    );

    expect(vi.mocked(parseDonation)).toHaveBeenCalledWith('hello', 'voice', llm);
    expect(donation.status).toBe('scored');
    expect(donation.id).toBeTruthy();
    expect(donation.sourceChannel).toBe('voice');
    expect(donation.sourceContact).toBe('+14155550100');
    expect(donation.donorName).toBe('Marcus');
    expect(donation.items).toHaveLength(2);
    for (const it of donation.items) {
      expect(it.id).toBeTruthy();
      expect(it.donationId).toBe(donation.id);
      expect(it.status).toBe('pending');
      expect(it.attempts).toEqual([]);
    }
    // unique ids
    const ids = new Set(donation.items.map((i) => i.id));
    expect(ids.size).toBe(2);
    // persisted
    expect(await store.getDonation(donation.id)).not.toBeNull();
    expect(store.saved.at(-1)?.status).toBe('scored');
  });
});

describe('dispatchDonation', () => {
  it('partial placement: one matched, one unplaceable ⇒ resolved with donorMessage', async () => {
    const donation: Donation = {
      id: 'd1', sourceChannel: 'voice', sourceContact: '+1',
      receivedAt: new Date().toISOString(), rawText: 'raw', status: 'scored',
      items: [
        { id: 'i1', donationId: 'd1', item: 'strawberries', qtyLbs: 5000, category: 'fresh_produce', hoursToSpoil: 48, needsRefrigeration: true, status: 'pending', attempts: [] },
        { id: 'i2', donationId: 'd1', item: 'bread', qtyLbs: 80, category: 'baked', hoursToSpoil: 24, needsRefrigeration: false, status: 'pending', attempts: [] },
      ],
    };
    const store = makeStore([donation]);
    const recipients = await store.listRecipients();

    // i1 has a feasible recipient who accepts; i2 has none at all (every option
    // hard-failed), which is the unplaceable-with-zero-calls path.
    vi.mocked(rankRecipients).mockImplementation((item: DonationItem) =>
      item.id === 'i1' ? rankedAs([recipients[0]]) : [],
    );
    vi.mocked(composeDonorMessage).mockResolvedValue(
      'Placed strawberries at A. Bread could not be placed. Thank you!',
    );
    const v = voiceFor({ r1: 'accepted' });

    const result = await dispatchDonation('d1', { store, llm, voice: v, config: DEFAULT_CONFIG });

    // both items worked; only the placeable one was ever dialed
    expect(vi.mocked(rankRecipients)).toHaveBeenCalledTimes(2);
    expect(v.calls).toEqual([{ itemId: 'i1', recipientId: 'r1' }]);
    expect(result.status).toBe('resolved');
    expect(result.donorMessage).toBeTruthy();
    expect(result.donorMessage).toContain('Bread');
    expect(result.items.find((i) => i.id === 'i1')?.status).toBe('matched');
    expect(result.items.find((i) => i.id === 'i2')?.status).toBe('unplaceable');
    // passed through 'dispatching' before resolving
    const statuses = store.saved.map((d) => d.status);
    expect(statuses).toContain('dispatching');
    expect(statuses.at(-1)).toBe('resolved');
  });

  it('throws when donation is missing', async () => {
    const store = makeStore();
    await expect(
      dispatchDonation('nope', { store, llm, voice, config: DEFAULT_CONFIG }),
    ).rejects.toThrow(/not found/);
  });

  it('does not re-dispatch already-resolved items', async () => {
    const donation: Donation = {
      id: 'd2', sourceChannel: 'voice', sourceContact: '+1',
      receivedAt: new Date().toISOString(), rawText: 'raw', status: 'scored',
      items: [
        { id: 'i3', donationId: 'd2', item: 'x', qtyLbs: 100, category: 'canned', hoursToSpoil: 2000, needsRefrigeration: false, status: 'matched', matchedRecipientId: 'r1', attempts: [] },
        { id: 'i4', donationId: 'd2', item: 'y', qtyLbs: 100, category: 'canned', hoursToSpoil: 2000, needsRefrigeration: false, status: 'pending', attempts: [] },
      ],
    };
    const store = makeStore([donation]);
    const recipients = await store.listRecipients();
    vi.mocked(rankRecipients).mockImplementation(() => rankedAs([recipients[1]]));
    vi.mocked(composeDonorMessage).mockResolvedValue('done');
    const v = voiceFor({ r2: 'accepted' });

    await dispatchDonation('d2', { store, llm, voice: v, config: DEFAULT_CONFIG });

    // i3 was already matched: never ranked, never called. Only i4 is worked.
    expect(vi.mocked(rankRecipients)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rankRecipients).mock.calls[0][0].id).toBe('i4');
    expect(v.calls).toEqual([{ itemId: 'i4', recipientId: 'r2' }]);
    expect(store.saved.at(-1)?.items.find((i) => i.id === 'i3')?.matchedRecipientId).toBe('r1');
  });

  it('returns after the FIRST call under a live provider — webhooks drive the rest', async () => {
    // The blocking loop ran the whole donation inside this one await. Live, the
    // outcome is not known when dispatchDonation returns: one call is in flight
    // and the item is still pending until its report lands.
    const donation: Donation = {
      id: 'd4', sourceChannel: 'voice', sourceContact: '+1',
      receivedAt: new Date().toISOString(), rawText: 'raw', status: 'scored',
      items: [
        { id: 'i5', donationId: 'd4', item: 'x', qtyLbs: 100, category: 'canned', hoursToSpoil: 2000, needsRefrigeration: false, status: 'pending', attempts: [] },
        { id: 'i6', donationId: 'd4', item: 'y', qtyLbs: 100, category: 'canned', hoursToSpoil: 2000, needsRefrigeration: false, status: 'pending', attempts: [] },
      ],
    };
    const store = makeStore([donation]);
    const recipients = await store.listRecipients();
    vi.mocked(rankRecipients).mockImplementation(() => rankedAs(recipients));

    const calls: string[] = [];
    const liveVoice: VoiceProvider = {           // no synthesizeReport ⇒ no webhook here
      async startCall(_offer, r, item) { calls.push(`${item.id}:${r.id}`); return 'live_1'; },
    };

    const result = await dispatchDonation('d4', { store, llm, voice: liveVoice, config: DEFAULT_CONFIG });

    expect(calls).toEqual(['i5:r1']);            // exactly one call, for the first item
    expect(result.status).toBe('dispatching');   // NOT resolved — nothing reported yet
    expect(result.items.every((i) => i.status === 'pending')).toBe(true);
    expect(result.items[0].dialing).toMatchObject({ recipientId: 'r1' });
    expect(vi.mocked(composeDonorMessage)).not.toHaveBeenCalled();
  });
});

describe('rankItem', () => {
  function ranked(order: string[]): RankedRecipient[] {
    return order.map((id, idx) => ({
      recipient: {
        id, name: id, type: 'pantry', leadContact: '', phone: '',
        lat: 0, lng: 0, infrastructure: [], accepts: [], rejects: [],
        typicalWeeklyVolumeLbs: 1000, receivedRecentLbs: 0,
      },
      score: {
        recipientId: id, feasibility: 0, coldchain: 0, capacity: 0, equity: 0,
        prefs: 0, total: 1 - idx * 0.1, driveTimeHours: 0, distanceMiles: 0,
      },
    }));
  }

  const donation: Donation = {
    id: 'd3', sourceChannel: 'voice', sourceContact: '+1',
    receivedAt: new Date().toISOString(), rawText: 'raw', status: 'scored',
    items: [
      { id: 'it1', donationId: 'd3', item: 'x', qtyLbs: 100, category: 'canned', hoursToSpoil: 2000, needsRefrigeration: false, status: 'pending', attempts: [] },
    ],
  };

  it('re-ranks statelessly and respects a weights override that changes order', async () => {
    const store = makeStore([donation]);
    vi.mocked(rankRecipients).mockImplementation(
      (_item, _don, _recips, config: AgentConfig) =>
        config.weights.equity > 0.5 ? ranked(['r2', 'r1']) : ranked(['r1', 'r2']),
    );

    const base = await rankItem('it1', undefined, { store, llm, voice, config: DEFAULT_CONFIG });
    expect(base.map((r) => r.recipient.id)).toEqual(['r1', 'r2']);

    const override: Weights = { feasibility: 0.1, coldchain: 0.1, capacity: 0.1, equity: 0.6, prefs: 0.1 };
    const shifted = await rankItem('it1', override, { store, llm, voice, config: DEFAULT_CONFIG });
    expect(shifted.map((r) => r.recipient.id)).toEqual(['r2', 'r1']);

    // override was passed through, base config left untouched (stateless)
    const passedConfig = vi.mocked(rankRecipients).mock.calls.at(-1)![3] as AgentConfig;
    expect(passedConfig.weights).toEqual(override);
    expect(DEFAULT_CONFIG.weights.equity).toBe(0.2);
  });

  it('throws when the item is not found', async () => {
    const store = makeStore([donation]);
    vi.mocked(rankRecipients).mockReturnValue([]);
    await expect(
      rankItem('missing', undefined, { store, llm, voice, config: DEFAULT_CONFIG }),
    ).rejects.toThrow(/not found/);
  });
});
