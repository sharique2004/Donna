import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Donation, DonationItem, Recipient, HistoryEvent, AgentConfig, CallRecord,
  OfferDraft, CallOutcome,
} from '../src/core/types.js';
import type { MemoryStore } from '../src/core/memory/store.js';
import type { LlmClient } from '../src/core/agents/llm.js';
import type { VoiceProvider } from '../src/core/voice/caller.js';
import { makeCallStoreParts } from './support/callStore.js';

/**
 * The dispatch state machine (§7.1) — formerly caller.ts's `dispatchItem` loop.
 *
 * Every behaviour the loop's tests pinned is asserted here unchanged; only the
 * mechanism moved. Where the loop ran start-to-finish inside one `await`, the
 * machine places ONE call and returns, and each outcome re-enters through
 * onCallReport. Two provider shapes exercise that:
 *
 *   simVoice  — has synthesizeReport, so the machine feeds its own decision back
 *               through onCallReport and a dispatch runs to completion inside
 *               startDispatch. This is the shape the old loop assertions use.
 *   liveVoice — startCall only. startDispatch returns with a call in flight and
 *               the test plays the webhook itself, which is the only way to test
 *               duplicate reports, dropped reports, and one-call-at-a-time.
 */

// ---- Mock the two collaborators the machine statically imports. ----
// rankRecipients: rank in array order; a recipient tagged __hardFail bubbles to
// total 0 with a hardFail set (exactly how the real engine surfaces hard gates).
vi.mock('../src/core/scoring/engine.js', () => ({
  rankRecipients: (_item: DonationItem, _donation: Donation, recipients: Recipient[]) =>
    recipients.map((r, idx) => {
      const hardFail = (r as Recipient & { __hardFail?: ScoreBreakdownHardFail }).__hardFail;
      return {
        recipient: r,
        score: {
          recipientId: r.id,
          feasibility: 1, coldchain: 1, capacity: 1, equity: 1, prefs: 1,
          total: hardFail ? 0 : 1 - idx * 0.1,
          hardFail,
          driveTimeHours: 0.2, distanceMiles: 6,
        },
      };
    }),
  scoreItem: vi.fn(),
}));

vi.mock('../src/core/agents/offer.js', () => ({
  draftOffer: async (item: DonationItem, _d: Donation, recipient: Recipient): Promise<OfferDraft> => ({
    itemId: item.id,
    recipientId: recipient.id,
    script: `Offer ${item.item} to ${recipient.name}`,
    summary: 'summary',
  }),
}));

// Import AFTER the mocks are declared (vi.mock is hoisted regardless).
import {
  startDispatch, onCallReport, sweepStaleCalls,
} from '../src/core/voice/dispatchMachine.js';
import { machineDeps } from '../src/core/pipeline.js';

type ScoreBreakdownHardFail = 'infeasible_time' | 'no_cold_chain' | 'category_rejected';

// ---- Test fixtures ----
function recipient(id: string, over: Partial<Recipient> = {}): Recipient {
  return {
    id,
    name: `Recipient ${id}`,
    type: 'pantry',
    leadContact: 'Lead',
    phone: `+1415555${id.padStart(4, '0')}`,
    lat: 37.76,
    lng: -122.42,
    infrastructure: ['fridge'],
    accepts: ['fresh_produce'],
    rejects: [],
    typicalWeeklyVolumeLbs: 4000,
    receivedRecentLbs: 100,
    ...over,
  };
}

function makeItem(id = 'i1'): DonationItem {
  return {
    id,
    donationId: 'd1',
    item: 'strawberries',
    qtyLbs: 500,
    category: 'fresh_produce',
    hoursToSpoil: 48,
    needsRefrigeration: true,
    status: 'pending',
    attempts: [],
  };
}

function makeDonation(items: DonationItem[] = [makeItem()]): Donation {
  return {
    id: 'd1',
    sourceChannel: 'voice',
    sourceContact: 'Marcus',
    receivedAt: new Date().toISOString(),
    rawText: 'strawberries',
    status: 'scored',
    pickupLat: 37.74,
    pickupLng: -122.39,
    items,
  };
}

const config: AgentConfig = {
  weights: { feasibility: 0.3, coldchain: 0.15, capacity: 0.2, equity: 0.2, prefs: 0.15 },
  autopilot: true,
  avgSpeedMph: 30,
};

// ---- Fake MemoryStore ----
function fakeStore(recipients: Recipient[], donations: Donation[] = []): MemoryStore & {
  history: HistoryEvent[];
  credits: Record<string, number>;
  calls: Map<string, CallRecord>;
} {
  const history: HistoryEvent[] = [];
  const credits: Record<string, number> = {};
  const byId = new Map(donations.map((d) => [d.id, d]));
  return {
    history,
    credits,
    ...makeCallStoreParts(),
    async init() {},
    async saveDonation(d) { byId.set(d.id, d); },
    async getDonation(id) { return byId.get(id) ?? null; },
    async listDonations() { return [...byId.values()]; },
    async listRecipients() { return recipients; },
    async getRecipient(id) { return recipients.find((r) => r.id === id) ?? null; },
    async updateRecipient(id, patch) {
      const r = recipients.find((x) => x.id === id)!;
      Object.assign(r, patch);
      return r;
    },
    async addHistory(e) { history.push(e); },
    async listHistory(recipientId) {
      return recipientId ? history.filter((h) => h.recipientId === recipientId) : history.slice();
    },
    async creditReceived(recipientId, lbs) {
      credits[recipientId] = (credits[recipientId] ?? 0) + lbs;
    },
    async getConfig() { return config; },
    async setConfig() { return config; },
    async reset() {},
  };
}

/**
 * A simulator-shaped provider: no webhook, so it answers its own calls. The
 * machine feeds the decision straight back through onCallReport, which is what
 * makes a simulated dispatch run to completion inside startDispatch.
 */
function simVoice(outcomes: Record<string, CallOutcome>): VoiceProvider & {
  calls: string[];
  historySeen: HistoryEvent[][];
} {
  const calls: string[] = [];
  const historySeen: HistoryEvent[][] = [];
  let n = 0;
  return {
    calls,
    historySeen,
    setHistory(h) { historySeen.push(h); },
    async startCall(_offer, recipient, _item) {
      calls.push(recipient.id);
      return `sim_call_${++n}`;
    },
    async synthesizeReport(_offer, recipient, _item) {
      const outcome = outcomes[recipient.id] ?? 'declined';
      return {
        outcome,
        reason: outcome === 'declined' ? 'we are full' : undefined,
        transcript: [{ speaker: 'agent' as const, text: 'hi' }],
      };
    },
  };
}

/**
 * A live-shaped provider: startCall only. The outcome arrives later, at the
 * webhook, so the test plays that part by calling onCallReport itself.
 */
function liveVoice(): VoiceProvider & {
  calls: Array<{ callId: string; recipientId: string; itemId: string }>;
} {
  const calls: Array<{ callId: string; recipientId: string; itemId: string }> = [];
  let n = 0;
  return {
    calls,
    async startCall(_offer, recipient, item) {
      const callId = `live_call_${++n}`;
      calls.push({ callId, recipientId: recipient.id, itemId: item.id });
      return callId;
    },
  };
}

const llm: LlmClient = { async complete() { return ''; } };

/**
 * Built through the REAL pipeline seam rather than hand-rolled, so these tests
 * also pin the wiring: placeCall→voice.startCall, refreshHistory→voice.setHistory
 * (the 7-day memory hook the old loop performed by calling setHistory on every
 * iteration), and composeDonorMessage→Agent 5.
 */
function deps(store: MemoryStore, voice: VoiceProvider) {
  return machineDeps({ store, llm, voice, config });
}

const itemOf = async (store: MemoryStore, itemId = 'i1'): Promise<DonationItem> => {
  const d = await store.getDonation('d1');
  return d!.items.find((it) => it.id === itemId)!;
};

describe('dispatch machine — shortlist walk (§7.1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path: first declines, second accepts → matched + credited + stop', async () => {
    const recips = [recipient('1'), recipient('2'), recipient('3')];
    const donation = makeDonation();
    const store = fakeStore(recips, [donation]);
    const voice = simVoice({ '1': 'declined', '2': 'accepted', '3': 'accepted' });

    await startDispatch(donation, deps(store, voice));
    const out = await itemOf(store);

    expect(out.status).toBe('matched');
    expect(out.matchedRecipientId).toBe('2');
    expect(out.resolutionReason).toContain('Recipient 2');
    // stopped at the acceptor — third recipient never called
    expect(voice.calls).toEqual(['1', '2']);
    // credited exactly the accepted recipient with the item weight
    expect(store.credits).toEqual({ '2': 500 });
    // every attempt appended
    expect(out.attempts).toHaveLength(2);
    // a provider that answers its own calls is the simulator
    expect(out.attempts.every((a) => a.simulated)).toBe(true);
    // history recorded for both attempts
    expect(store.history).toHaveLength(2);
    expect(store.history[0]).toMatchObject({ recipientId: '1', outcome: 'declined', reason: 'we are full' });
    expect(store.history[1]).toMatchObject({ recipientId: '2', outcome: 'accepted' });
  });

  it('all-decline path → unplaceable, no credit, all attempts recorded', async () => {
    const recips = [recipient('1'), recipient('2'), recipient('3')];
    const donation = makeDonation();
    const store = fakeStore(recips, [donation]);
    const voice = simVoice({ '1': 'declined', '2': 'declined', '3': 'declined' });

    await startDispatch(donation, deps(store, voice));
    const out = await itemOf(store);

    expect(out.status).toBe('unplaceable');
    expect(out.matchedRecipientId).toBeUndefined();
    expect(out.resolutionReason).toContain('No recipient accepted');
    expect(voice.calls).toEqual(['1', '2', '3']);
    expect(out.attempts).toHaveLength(3);
    expect(store.history).toHaveLength(3);
    expect(store.credits).toEqual({});
  });

  it('caps at 3 candidates and skips hard-failed recipients', async () => {
    const recips = [
      recipient('1', { __hardFail: 'category_rejected' } as Partial<Recipient>),
      recipient('2'),
      recipient('3'),
      recipient('4'),
      recipient('5', { __hardFail: 'no_cold_chain' } as Partial<Recipient>),
    ];
    const donation = makeDonation();
    const store = fakeStore(recips, [donation]);
    const voice = simVoice({}); // everyone declines by default

    await startDispatch(donation, deps(store, voice));
    const out = await itemOf(store);

    // hard-failed 1 and 5 never called; only top 3 feasible (2,3,4)
    expect(voice.calls).toEqual(['2', '3', '4']);
    expect(out.attempts).toHaveLength(3);
    expect(out.status).toBe('unplaceable');
  });

  it('no feasible recipient (all hard-failed) → unplaceable, zero calls', async () => {
    const recips = [
      recipient('1', { __hardFail: 'infeasible_time' } as Partial<Recipient>),
      recipient('2', { __hardFail: 'no_cold_chain' } as Partial<Recipient>),
    ];
    const donation = makeDonation();
    const store = fakeStore(recips, [donation]);
    const voice = simVoice({});

    await startDispatch(donation, deps(store, voice));
    const out = await itemOf(store);

    expect(voice.calls).toEqual([]);
    expect(out.attempts).toHaveLength(0);
    expect(out.status).toBe('unplaceable');
    expect(out.resolutionReason).toContain('No feasible recipient');
  });

  it('feeds live history to the voice provider before each call (7-day memory hook)', async () => {
    const recips = [recipient('1'), recipient('2')];
    const donation = makeDonation();
    const store = fakeStore(recips, [donation]);
    const voice = simVoice({ '1': 'declined', '2': 'accepted' });

    await startDispatch(donation, deps(store, voice));

    // refreshHistory runs once per attempt; the 2nd call must include the 1st decline
    expect(voice.historySeen).toHaveLength(2);
    expect(voice.historySeen[0]).toHaveLength(0);
    expect(voice.historySeen[1]).toHaveLength(1);
    expect(voice.historySeen[1][0]).toMatchObject({ recipientId: '1', outcome: 'declined' });
  });

  it('ranks once per item: a recipient that declined cannot climb back onto the shortlist', async () => {
    // The shortlist is computed at approve and persisted. Re-ranking on each
    // report would let a pantry that already said no return to the top and be
    // dialed again — on the stack this was guaranteed by the `for` loop.
    const recips = [recipient('1'), recipient('2')];
    const donation = makeDonation();
    const store = fakeStore(recips, [donation]);
    const voice = simVoice({ '1': 'declined', '2': 'declined' });

    await startDispatch(donation, deps(store, voice));
    const out = await itemOf(store);

    expect(out.candidateRecipientIds).toEqual(['1', '2']);
    expect(voice.calls).toEqual(['1', '2']);
  });
});

describe('dispatch machine — duplicate reports (idempotency)', () => {
  /**
   * VAPI provably sends more than one end-of-call-report per call: captured live
   * on 2026-07-16, a premature `call.in-progress.*` report arrived seconds before
   * the real one. parseWebhook screens that specific shape, but nothing stops two
   * genuine reports (or a VAPI retry) landing twice — and on a serverless runtime
   * they may land in different invocations, so no in-process flag can help.
   *
   * claimCall is the guard. Without it the second report advances the machine a
   * second time and dials the next pantry twice over.
   */
  it('a duplicate report records ONE attempt and places ONE next call', async () => {
    const recips = [recipient('1'), recipient('2'), recipient('3')];
    const donation = makeDonation();
    const store = fakeStore(recips, [donation]);
    const voice = liveVoice();
    const d = deps(store, voice);

    await startDispatch(donation, d);
    expect(voice.calls).toHaveLength(1);
    const first = voice.calls[0].callId;

    const handled = await onCallReport(first, 'declined', 'we are full', [], d);
    expect(handled).toBe(true);
    // the decline moved us on to candidate 2
    expect(voice.calls.map((c) => c.recipientId)).toEqual(['1', '2']);

    // The duplicate. It must be a no-op, not a second dial.
    const again = await onCallReport(first, 'declined', 'we are full', [], d);
    expect(again).toBe(false);

    expect(voice.calls.map((c) => c.recipientId)).toEqual(['1', '2']);
    const out = await itemOf(store);
    expect(out.attempts).toHaveLength(1);
    expect(store.history).toHaveLength(1);
    // a real webhook resolved this one — not the simulator
    expect(out.attempts[0].simulated).toBe(false);
  });

  it('a duplicate ACCEPT credits the ledger once and does not double-resolve', async () => {
    const recips = [recipient('1')];
    const donation = makeDonation();
    const store = fakeStore(recips, [donation]);
    const voice = liveVoice();
    const d = deps(store, voice);

    await startDispatch(donation, d);
    const first = voice.calls[0].callId;

    expect(await onCallReport(first, 'accepted', undefined, [], d)).toBe(true);
    expect(await onCallReport(first, 'accepted', undefined, [], d)).toBe(false);

    const out = await itemOf(store);
    expect(out.status).toBe('matched');
    expect(out.attempts).toHaveLength(1);
    expect(store.credits).toEqual({ '1': 500 });
    expect(voice.calls).toHaveLength(1);
  });

  it('a report for a call we never placed is ignored', async () => {
    const donation = makeDonation();
    const store = fakeStore([recipient('1')], [donation]);
    const d = deps(store, liveVoice());
    expect(await onCallReport('never_placed', 'accepted', undefined, [], d)).toBe(false);
  });
});

describe('dispatch machine — sweepStaleCalls (the report that never came)', () => {
  /**
   * The old design raced each call against an in-process setTimeout. No timer
   * survives a serverless invocation, so a dropped webhook would strand the
   * donation at `dispatching` forever. The cron sweep replaces it.
   */
  it('sweeps an unreported call to no_answer and advances the machine', async () => {
    const recips = [recipient('1'), recipient('2')];
    const donation = makeDonation();
    const store = fakeStore(recips, [donation]);
    const voice = liveVoice();
    const d = deps(store, voice);

    await startDispatch(donation, d);
    expect(voice.calls).toHaveLength(1);

    // No report ever arrives. Age the call past the grace window.
    store.calls.get(voice.calls[0].callId)!.placedAt =
      new Date(Date.now() - 10 * 60_000).toISOString();

    const swept = await sweepStaleCalls(60_000, d);
    expect(swept).toBe(1);

    const out = await itemOf(store);
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0]).toMatchObject({ recipientId: '1', outcome: 'no_answer' });
    // …and it moved on to the next candidate rather than stopping — the stranded
    // call's `dialing` is replaced by the new one, never left pointing at #1.
    expect(voice.calls.map((c) => c.recipientId)).toEqual(['1', '2']);
    expect(out.dialing).toMatchObject({ recipientId: '2' });
  });

  it('leaves a fresh in-flight call alone', async () => {
    const donation = makeDonation();
    const store = fakeStore([recipient('1'), recipient('2')], [donation]);
    const voice = liveVoice();
    const d = deps(store, voice);

    await startDispatch(donation, d);
    expect(await sweepStaleCalls(60_000, d)).toBe(0);
    expect(voice.calls).toHaveLength(1);
    expect((await itemOf(store)).attempts).toHaveLength(0);
  });

  it('a swept last candidate resolves the donation instead of stranding it at dispatching', async () => {
    const donation = makeDonation();
    const store = fakeStore([recipient('1')], [donation]);
    const voice = liveVoice();
    const d = deps(store, voice);

    await startDispatch(donation, d);
    expect(donation.status).toBe('dispatching');

    store.calls.get(voice.calls[0].callId)!.placedAt =
      new Date(Date.now() - 10 * 60_000).toISOString();
    await sweepStaleCalls(60_000, d);

    const after = (await store.getDonation('d1'))!;
    expect(after.items[0].status).toBe('unplaceable');
    expect(after.status).toBe('resolved');
    expect(after.donorMessage).toBeTruthy();
  });

  it('does not re-sweep a call that was already reported', async () => {
    const donation = makeDonation();
    const store = fakeStore([recipient('1'), recipient('2')], [donation]);
    const voice = liveVoice();
    const d = deps(store, voice);

    await startDispatch(donation, d);
    const first = voice.calls[0].callId;
    await onCallReport(first, 'declined', 'we are full', [], d);
    store.calls.get(first)!.placedAt = new Date(Date.now() - 10 * 60_000).toISOString();

    expect(await sweepStaleCalls(60_000, d)).toBe(0);
    expect((await itemOf(store)).attempts).toHaveLength(1);
  });
});

describe('dispatch machine — items go strictly one at a time', () => {
  /**
   * Nothing technical forces this: event-driven, every item's first call could
   * fire at once. But LIVE_CALL_PHONE_OVERRIDE points every call at one handset,
   * so parallel dispatch would ring the demo phone three times simultaneously.
   */
  it('only ONE call is in flight at a time across a multi-item donation', async () => {
    const recips = [recipient('1'), recipient('2')];
    const donation = makeDonation([makeItem('i1'), makeItem('i2'), makeItem('i3')]);
    const store = fakeStore(recips, [donation]);
    const voice = liveVoice();
    const d = deps(store, voice);

    // `dialing` is set before a call and cleared when its report lands, so it is
    // the honest count of handsets ringing right now.
    const inFlight = async (): Promise<number> => {
      const cur = (await store.getDonation('d1'))!;
      return cur.items.filter((it) => it.dialing).length;
    };

    await startDispatch(donation, d);
    expect(voice.calls).toHaveLength(1);
    expect(voice.calls[0].itemId).toBe('i1');
    expect(await inFlight()).toBe(1);

    // Accepting item 1 advances the cursor: exactly one new call, for item 2.
    await onCallReport(voice.calls[0].callId, 'accepted', undefined, [], d);
    expect(voice.calls).toHaveLength(2);
    expect(voice.calls[1].itemId).toBe('i2');
    expect(await inFlight()).toBe(1);

    await onCallReport(voice.calls[1].callId, 'accepted', undefined, [], d);
    expect(voice.calls).toHaveLength(3);
    expect(voice.calls[2].itemId).toBe('i3');
    expect(await inFlight()).toBe(1);

    await onCallReport(voice.calls[2].callId, 'accepted', undefined, [], d);
    expect(voice.calls).toHaveLength(3);
    expect(await inFlight()).toBe(0);

    const after = (await store.getDonation('d1'))!;
    expect(after.status).toBe('resolved');
    expect(after.items.every((it) => it.status === 'matched')).toBe(true);
  });

  it('an item exhausting its shortlist still only ever has one call out', async () => {
    // Item 1 burns through both candidates before item 2 is touched at all.
    const recips = [recipient('1'), recipient('2')];
    const donation = makeDonation([makeItem('i1'), makeItem('i2')]);
    const store = fakeStore(recips, [donation]);
    const voice = liveVoice();
    const d = deps(store, voice);

    await startDispatch(donation, d);
    await onCallReport(voice.calls[0].callId, 'declined', 'full', [], d);
    expect(voice.calls.map((c) => `${c.itemId}:${c.recipientId}`)).toEqual(['i1:1', 'i1:2']);

    await onCallReport(voice.calls[1].callId, 'declined', 'full', [], d);
    // i1 exhausted ⇒ unplaceable, and only NOW does i2 get its first call
    expect(voice.calls.map((c) => `${c.itemId}:${c.recipientId}`)).toEqual(['i1:1', 'i1:2', 'i2:1']);
    const after = (await store.getDonation('d1'))!;
    expect(after.items[0].status).toBe('unplaceable');
    expect(after.items.filter((it) => it.dialing)).toHaveLength(1);
  });

  it('skips items that are already resolved', async () => {
    const donation = makeDonation([
      { ...makeItem('i1'), status: 'matched' as const, matchedRecipientId: '1' },
      makeItem('i2'),
    ]);
    const store = fakeStore([recipient('1')], [donation]);
    const voice = liveVoice();

    await startDispatch(donation, deps(store, voice));

    expect(voice.calls).toHaveLength(1);
    expect(voice.calls[0].itemId).toBe('i2');
  });
});

describe('dispatch machine — a call that cannot be placed', () => {
  it('records no_answer and moves to the next candidate rather than stranding the item', async () => {
    const recips = [recipient('1'), recipient('2')];
    const donation = makeDonation();
    const store = fakeStore(recips, [donation]);
    const calls: string[] = [];
    const voice: VoiceProvider = {
      async startCall(_offer, r) {
        calls.push(r.id);
        if (r.id === '1') throw new Error('invalid phone number');
        return 'live_ok';
      },
    };

    await startDispatch(donation, deps(store, voice));

    expect(calls).toEqual(['1', '2']);
    const out = await itemOf(store);
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0]).toMatchObject({ recipientId: '1', outcome: 'no_answer' });
    expect(out.attempts[0].reason).toContain('invalid phone number');
    expect(out.status).toBe('pending'); // call 2 is in flight, awaiting its report
  });
});
