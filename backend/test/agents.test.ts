import { describe, it, expect } from 'vitest';

import { extractJson } from '../src/core/agents/llm.js';
import { LlmMock } from '../src/core/agents/llmMock.js';
import { parseDonation } from '../src/core/agents/intake.js';
import { managerChat } from '../src/core/agents/manager.js';
import { composeDonorMessage } from '../src/core/agents/callback.js';
import { draftOffer } from '../src/core/agents/offer.js';
import { CANNED_SCENARIO } from '../src/seed/scenarios.js';
import type {
  Donation, DonationItem, Recipient, AgentConfig,
} from '../src/core/types.js';
import type { MemoryStore } from '../src/core/memory/store.js';
import type { LlmClient as LlmClientType } from '../src/core/agents/llm.js';
import { DEFAULT_AGENT_CONFIG } from '../src/config.js';
import { makeCallStoreParts } from './support/callStore.js';

// ---------------------------------------------------------------------------
// In-memory MemoryStore stub (only the methods the manager agent exercises).
// ---------------------------------------------------------------------------

function makeStore(recipients: Recipient[]): MemoryStore {
  const map = new Map(recipients.map((r) => [r.id, { ...r }]));
  let config: AgentConfig = { ...DEFAULT_AGENT_CONFIG, weights: { ...DEFAULT_AGENT_CONFIG.weights } };
  return {
    ...makeCallStoreParts(),
    async init() {},
    async saveDonation() {},
    async getDonation() { return null; },
    async listDonations() { return []; },
    async listRecipients() { return Array.from(map.values()).map((r) => ({ ...r })); },
    async getRecipient(id) { const r = map.get(id); return r ? { ...r } : null; },
    async updateRecipient(id, patch) {
      const r = map.get(id);
      if (!r) throw new Error(`no recipient ${id}`);
      const next = { ...r, ...patch };
      map.set(id, next);
      return { ...next };
    },
    async addHistory() {},
    async listHistory() { return []; },
    async creditReceived() {},
    async getConfig() { return { ...config, weights: { ...config.weights } }; },
    async setConfig(patch) {
      config = { ...config, ...patch, weights: { ...config.weights, ...(patch.weights ?? {}) } };
      return { ...config, weights: { ...config.weights } };
    },
    async reset() {},
  };
}

function stMarys(): Recipient {
  return {
    id: 'r-stmarys',
    name: "St. Mary's Center",
    type: 'community_agency',
    leadContact: 'Rosa',
    phone: '+14155550110',
    lat: 37.78,
    lng: -122.41,
    infrastructure: ['dry_storage', 'loading_dock'],
    accepts: ['canned', 'dry_goods'],
    rejects: [],
    typicalWeeklyVolumeLbs: 1200,
    receivedRecentLbs: 300,
  };
}

// A fake LLM that returns a fixed JSON string regardless of the prompt.
function fakeLlm(json: string): LlmClientType {
  return { async complete() { return json; } };
}

// ---------------------------------------------------------------------------
// Agent 1 — canned transcript exact parse (§12)
// ---------------------------------------------------------------------------

describe('intake — canned transcript exact parse', () => {
  it('parses the §12 voicemail to the exact expected items', async () => {
    const parsed = await parseDonation(CANNED_SCENARIO.rawText, 'voice');

    expect(parsed.items).toHaveLength(3);

    const byCat = Object.fromEntries(parsed.items.map((i) => [i.category, i]));

    // strawberries → 5 pallets = 5000 lbs, fresh_produce, 48h, refrigerated
    const straw = byCat['fresh_produce'];
    expect(straw).toBeDefined();
    expect(straw.qtyLbs).toBe(5000);
    expect(straw.hoursToSpoil).toBe(48);
    expect(straw.needsRefrigeration).toBe(true);
    expect(straw.item.toLowerCase()).toContain('strawberr');

    // canned black beans → 200 lbs, canned, ~90 days, no fridge
    const beans = byCat['canned'];
    expect(beans).toBeDefined();
    expect(beans.qtyLbs).toBe(200);
    expect(beans.hoursToSpoil).toBe(2160);
    expect(beans.needsRefrigeration).toBe(false);

    // day-old bread → 80 lbs, baked, 24h, no fridge
    const bread = byCat['baked'];
    expect(bread).toBeDefined();
    expect(bread.qtyLbs).toBe(80);
    expect(bread.hoursToSpoil).toBe(24);
    expect(bread.needsRefrigeration).toBe(false);

    // pickup coords ≈ (37.7455, -122.3934)
    expect(parsed.pickupLat).toBeCloseTo(37.7455, 3);
    expect(parsed.pickupLng).toBeCloseTo(-122.3934, 3);
    expect(parsed.donorName).toBe('Marcus');
  });
});

// ---------------------------------------------------------------------------
// extractJson tolerance
// ---------------------------------------------------------------------------

describe('extractJson tolerance', () => {
  it('parses raw JSON', () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  it('parses ```json fenced blocks', () => {
    const raw = 'Here you go:\n```json\n{"a": 2, "b": [1,2]}\n```\nDone.';
    expect(extractJson<{ a: number; b: number[] }>(raw)).toEqual({ a: 2, b: [1, 2] });
  });
  it('parses bare ``` fenced blocks', () => {
    expect(extractJson<{ ok: boolean }>('```\n{"ok": true}\n```')).toEqual({ ok: true });
  });
  it('extracts JSON embedded in prose', () => {
    const raw = 'The answer is {"name": "Donna", "n": 3} — hope that helps!';
    expect(extractJson<{ name: string; n: number }>(raw)).toEqual({ name: 'Donna', n: 3 });
  });
  it('handles braces inside JSON strings', () => {
    const raw = 'prefix {"text": "a } b { c"} suffix';
    expect(extractJson<{ text: string }>(raw)).toEqual({ text: 'a } b { c' });
  });
  it('throws on non-JSON input', () => {
    expect(() => extractJson('no json here at all')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Agent 4 — manager patch validation
// ---------------------------------------------------------------------------

describe('manager — patch validation & application', () => {
  it('applies a valid freezer add for a fuzzily-matched recipient', async () => {
    const store = makeStore([stMarys()]);
    const reply = await managerChat("St. Mary's just got a new walk-in freezer", store);

    expect(reply.applied).toBe(true);
    expect(reply.patches.length).toBeGreaterThan(0);

    const updated = await store.getRecipient('r-stmarys');
    expect(updated).not.toBeNull();
    expect(updated!.infrastructure).toContain('freezer');
    expect(updated!.infrastructure).toContain('walk_in_fridge');
  });

  it('rejects a patch that targets an unknown recipient id', async () => {
    const store = makeStore([stMarys()]);
    const llm = fakeLlm(JSON.stringify({
      reply: 'ok',
      patches: [{ op: 'add_infrastructure', recipientId: 'does-not-exist', value: 'freezer' }],
    }));
    const reply = await managerChat('add a freezer somewhere', store, llm);

    expect(reply.applied).toBe(false);
    expect(reply.patches).toHaveLength(0);
    expect(reply.reply.toLowerCase()).toContain('unknown recipient');
    // Real recipient untouched.
    const r = await store.getRecipient('r-stmarys');
    expect(r!.infrastructure).not.toContain('freezer');
  });

  it('rejects an unknown op politely', async () => {
    const store = makeStore([stMarys()]);
    const llm = fakeLlm(JSON.stringify({
      reply: 'sure',
      patches: [{ op: 'delete_recipient', recipientId: 'r-stmarys', value: null }],
    }));
    const reply = await managerChat('delete st marys', store, llm);
    expect(reply.applied).toBe(false);
    expect(reply.reply.toLowerCase()).toContain('unknown operation');
  });

  it('applies set_rejects (stop sending) via the mock pattern matcher', async () => {
    const store = makeStore([stMarys()]);
    const reply = await managerChat("stop sending dairy to St. Mary's", store);
    expect(reply.applied).toBe(true);
    const r = await store.getRecipient('r-stmarys');
    expect(r!.rejects).toContain('dairy');
  });
});

// ---------------------------------------------------------------------------
// Agent 5 — callback mentions every item
// ---------------------------------------------------------------------------

describe('callback — mentions every item', () => {
  it('names each placed and unplaceable item', async () => {
    const items: DonationItem[] = [
      {
        id: 'i1', donationId: 'd1', item: 'strawberries', qtyLbs: 5000,
        category: 'fresh_produce', hoursToSpoil: 48, needsRefrigeration: true,
        status: 'matched', matchedRecipientId: 'rA',
        attempts: [{
          recipientId: 'rA', recipientName: 'Harbor Pantry', outcome: 'accepted',
          transcript: [], at: new Date().toISOString(), simulated: true,
        }],
      },
      {
        id: 'i2', donationId: 'd1', item: 'canned black beans', qtyLbs: 200,
        category: 'canned', hoursToSpoil: 2160, needsRefrigeration: false,
        status: 'matched', matchedRecipientId: 'rB',
        attempts: [{
          recipientId: 'rB', recipientName: 'Mission Agency', outcome: 'accepted',
          transcript: [], at: new Date().toISOString(), simulated: true,
        }],
      },
      {
        id: 'i3', donationId: 'd1', item: 'day-old bread', qtyLbs: 80,
        category: 'baked', hoursToSpoil: 24, needsRefrigeration: false,
        status: 'unplaceable', resolutionReason: 'no feasible recipient in time',
        attempts: [],
      },
    ];
    const donation: Donation = {
      id: 'd1', sourceChannel: 'voice', sourceContact: '+14155550142',
      receivedAt: new Date().toISOString(), rawText: '...', status: 'resolved',
      donorName: 'Marcus', items,
    };

    const msg = await composeDonorMessage(donation, new LlmMock());
    expect(msg).toContain('strawberries');
    expect(msg).toContain('canned black beans');
    expect(msg).toContain('day-old bread');
    expect(msg).toContain('Harbor Pantry');
    expect(msg).toContain('Mission Agency');
    expect(msg).toContain('Marcus');
    // ≤120 words
    expect(msg.split(/\s+/).length).toBeLessThanOrEqual(120);
    // §D.3 — humane copy: never dumps the DB row or raw enum tokens.
    expect(msg).not.toContain('Infrastructure:');
    expect(msg).not.toContain('Prefers:');
    expect(msg).not.toContain('Does not take:');
    expect(msg).not.toMatch(/[a-z]_[a-z]/); // no snake_case enum tokens
  });
});

// ---------------------------------------------------------------------------
// Agent 2 — offer draft is built from real inputs
// ---------------------------------------------------------------------------

describe('offer — draft is a short, human script (§D.3)', () => {
  it('greets by first name, states the item, and never dumps the DB row', async () => {
    const item: DonationItem = {
      id: 'i1', donationId: 'd1', item: 'strawberries', qtyLbs: 5000,
      category: 'fresh_produce', hoursToSpoil: 48, needsRefrigeration: true,
      status: 'pending', attempts: [],
    };
    const donation: Donation = {
      id: 'd1', sourceChannel: 'voice', sourceContact: 'x',
      receivedAt: new Date().toISOString(), rawText: '', status: 'scored',
      donorName: 'Marcus', pickupLocation: '2200 Jerrold Ave', items: [item],
    };
    const recipient = stMarys(); // leadContact 'Rosa'
    const draft = await draftOffer(item, donation, recipient, '', new LlmMock());

    expect(draft.itemId).toBe('i1');
    expect(draft.recipientId).toBe('r-stmarys');

    // Tied to the real inputs, in a warm spoken register.
    expect(draft.script).toContain('strawberries');
    expect(draft.script).toContain('Rosa'); // first-name greeting
    expect(draft.summary.toLowerCase()).toContain('strawberries');

    // Forbidden: reciting the recipient's DB row / raw enum tokens.
    expect(draft.script).not.toContain('Infrastructure:');
    expect(draft.script).not.toContain('Prefers:');
    expect(draft.script).not.toContain('Does not take:');
    expect(draft.script).not.toMatch(/[a-z]_[a-z]/); // no snake_case enum tokens

    // ≤2 spoken sentences.
    const sentences = draft.script.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
    expect(sentences.length).toBeLessThanOrEqual(2);
  });

  it('includes at most one contextual memory clause when relevant', async () => {
    const item: DonationItem = {
      id: 'i2', donationId: 'd2', item: 'fresh spinach', qtyLbs: 300,
      category: 'fresh_produce', hoursToSpoil: 36, needsRefrigeration: true,
      status: 'pending', attempts: [],
    };
    const donation: Donation = {
      id: 'd2', sourceChannel: 'voice', sourceContact: 'x',
      receivedAt: new Date().toISOString(), rawText: '', status: 'scored',
      donorName: 'Marcus', items: [item],
    };
    // A recipient WITH a walk-in fridge → the one allowed contextual clause,
    // humanized (never the raw 'walk_in_fridge' token).
    const recipient = { ...stMarys(), infrastructure: ['walk_in_fridge' as const] };
    const draft = await draftOffer(item, donation, recipient, '', new LlmMock());

    expect(draft.script).toContain('walk-in fridge');
    expect(draft.script).not.toContain('walk_in_fridge');
    const sentences = draft.script.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
    expect(sentences.length).toBeLessThanOrEqual(2);
  });
});
