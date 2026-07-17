import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseWebhook, VapiVoice } from '../src/core/voice/vapi.js';
import { ENV } from '../src/config.js';

describe('vapi.parseWebhook (§7.3 normalization)', () => {
  it('normalizes an end-of-call-report with call.id, transcript, and success', () => {
    const body = {
      message: {
        type: 'end-of-call-report',
        endedReason: 'hangup',
        call: { id: 'call_123' },
        analysis: { successEvaluation: true, summary: 'They accepted the produce.' },
        artifact: {
          transcript: 'AI: hi\nUser: yes we will take it',
          messages: [
            { role: 'system', message: 'You are Donna' },
            { role: 'assistant', message: 'Hi, produce for you?' },
            { role: 'user', message: 'Yes we will take it' },
          ],
        },
      },
    };
    const hook = parseWebhook(body);
    expect(hook.type).toBe('end-of-call-report');
    expect(hook.callId).toBe('call_123');
    expect(hook.outcome).toBe('accepted');
    // system message dropped; roles mapped to agent/recipient
    expect(hook.transcript).toEqual([
      { speaker: 'agent', text: 'Hi, produce for you?' },
      { speaker: 'recipient', text: 'Yes we will take it' },
    ]);
  });

  it('maps no-answer endedReason values to no_answer', () => {
    for (const endedReason of ['customer-did-not-answer', 'voicemail', 'customer-busy']) {
      const hook = parseWebhook({
        message: { type: 'end-of-call-report', endedReason, call: { id: 'c' } },
      });
      expect(hook.outcome).toBe('no_answer');
      expect(hook.reason).toBe(endedReason);
    }
  });

  it('derives declined from a false successEvaluation', () => {
    const hook = parseWebhook({
      message: {
        type: 'end-of-call-report',
        endedReason: 'hangup',
        call: { id: 'c' },
        analysis: { successEvaluation: false, summary: "we're full this week" },
      },
    });
    expect(hook.outcome).toBe('declined');
    expect(hook.reason).toBe("we're full this week");
  });

  it('falls back to transcript text heuristics when no analysis present', () => {
    const hook = parseWebhook({
      message: {
        type: 'end-of-call-report',
        endedReason: 'hangup',
        call: { id: 'c' },
        artifact: { transcript: 'User: sorry we cannot take that, we are full' },
      },
    });
    expect(hook.outcome).toBe('declined');
  });

  it('accepts the alternate string successEvaluation values', () => {
    const hook = parseWebhook({
      message: {
        type: 'end-of-call-report',
        endedReason: 'hangup',
        call: { id: 'c' },
        analysis: { successEvaluation: 'pass' },
      },
    });
    expect(hook.outcome).toBe('accepted');
  });

  it('throws on a non end-of-call-report message type', () => {
    expect(() => parseWebhook({ message: { type: 'status-update' } })).toThrow();
  });

  it('throws when the call id is missing', () => {
    expect(() => parseWebhook({ message: { type: 'end-of-call-report' } })).toThrow();
  });

  it('accepts a bare (unwrapped) message body', () => {
    const hook = parseWebhook({
      type: 'end-of-call-report',
      endedReason: 'customer-did-not-answer',
      call: { id: 'c9' },
    });
    expect(hook.callId).toBe('c9');
    expect(hook.outcome).toBe('no_answer');
  });
});

describe('VapiVoice keyless behavior', () => {
  it('constructs without any env keys', () => {
    expect(() => new VapiVoice()).not.toThrow();
  });

  describe('LIVE_CALL_PHONE_OVERRIDE', () => {
    const RECIPIENT = {
      id: 'rec-bayview-hub', name: 'Bayview Community Food Hub', type: 'pantry' as const,
      leadContact: 'Denise Carter', phone: '+14155550101',
      lat: 0, lng: 0, infrastructure: [], accepts: [], rejects: [],
      typicalWeeklyVolumeLbs: 100, receivedRecentLbs: 0,
    };
    const OFFER = { itemId: 'i', recipientId: 'rec-bayview-hub', script: 's', summary: 'x' };
    const ITEM = {
      id: 'i', donationId: 'd', item: 'strawberries', qtyLbs: 1,
      category: 'fresh_produce' as const,
      hoursToSpoil: 10, needsRefrigeration: true, status: 'pending' as const, attempts: [],
    };

    const saved = { ...ENV };
    afterEach(() => {
      Object.assign(ENV, saved);
      vi.unstubAllGlobals();
    });

    /** Stub /call and capture the number that got dialed. */
    async function capturePostedNumber(): Promise<string> {
      let posted: string | undefined;
      vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
        posted = JSON.parse(init.body).customer.number;
        return { ok: true, json: async () => ({ id: 'call_stub' }) } as unknown as Response;
      });
      // startCall settles as soon as VAPI accepts the call for dialling — the old
      // placeCall parked until a webhook resolved it, which is why this used to
      // have to race a tick and abandon the promise.
      const callId = await new VapiVoice().startCall(OFFER, RECIPIENT, ITEM);
      expect(callId).toBe('call_stub');
      return posted!;
    }

    it('dials the override instead of the ranked recipient when set', async () => {
      Object.assign(ENV, {
        vapiApiKey: 'k', vapiPhoneNumberId: 'p', liveCallPhoneOverride: '+15555550123',
      });
      expect(await capturePostedNumber()).toBe('+15555550123');
    });

    it("dials the recipient's real phone when unset", async () => {
      Object.assign(ENV, {
        vapiApiKey: 'k', vapiPhoneNumberId: 'p', liveCallPhoneOverride: '',
      });
      expect(await capturePostedNumber()).toBe('+14155550101');
    });
  });

  /**
   * The outbound assistant invented provenance live on 2026-07-16 ("a farm just
   * outside Watsonville" against a record saying Golden State Produce, Dock 12).
   * inbound.ts had already diagnosed the cause — an unanswerable question with no
   * instruction to decline — and fixed only its own prompt. These assert the
   * outbound half carries the same rules, since nothing else would catch its
   * removal: the prompt is a string posted to VAPI and never otherwise read.
   */
  describe('outbound system prompt', () => {
    const RECIPIENT = {
      id: 'r1', name: 'Bayview Community Food Hub', type: 'pantry' as const,
      leadContact: 'Denise Carter', phone: '+14155550101',
      lat: 0, lng: 0, infrastructure: [], accepts: [], rejects: [],
      typicalWeeklyVolumeLbs: 100, receivedRecentLbs: 0,
    };
    const OFFER = { itemId: 'i', recipientId: 'r1', script: 'Hi Denise — produce for you?', summary: 'x' };
    const ITEM = {
      id: 'i', donationId: 'd', item: 'strawberries', qtyLbs: 240,
      category: 'fresh_produce' as const,
      hoursToSpoil: 10, needsRefrigeration: true, status: 'pending' as const, attempts: [],
    };

    const saved = { ...ENV };
    afterEach(() => {
      Object.assign(ENV, saved);
      vi.unstubAllGlobals();
    });

    /** Place a call against a stubbed VAPI and return the system prompt it posted. */
    async function capturePrompt(): Promise<string> {
      Object.assign(ENV, { vapiApiKey: 'k', vapiPhoneNumberId: 'p' });
      let body: any;
      vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body);
        return { ok: true, json: async () => ({ id: 'call_stub' }) } as unknown as Response;
      });
      await new VapiVoice().startCall(OFFER, RECIPIENT, ITEM);
      return body.assistant.model.messages[0].content as string;
    }

    it('still states the offer it is calling about', async () => {
      const p = await capturePrompt();
      expect(p).toContain('Bayview Community Food Hub');
      expect(p).toContain('240 lbs of strawberries');
      expect(p).toContain('needs refrigeration');
    });

    it('forbids inventing facts and names sourcing as unknown', async () => {
      const p = await capturePrompt();
      expect(p).toContain('NEVER invent facts');
      // The literal thing it invented: where the food came from.
      expect(p).toMatch(/where it was grown or sourced/);
      expect(p).toMatch(/farm, supplier or donor/);
    });

    it('tells Donna to defer rather than guess, and not to reassign her employer', async () => {
      const p = await capturePrompt();
      expect(p).toMatch(/do not have it in front of you/);
      expect(p).toMatch(/never name a different organisation/);
    });

    it('discloses that Donna is an AI when asked', async () => {
      const p = await capturePrompt();
      expect(p).toMatch(/you are an AI assistant/);
    });

    it('names the food bank as a bare proper noun, never doubling the article', async () => {
      // FOOD_BANK_NAME resolves at module load, so this asserts the default a
      // deployment falls back to when the var is unset.
      const p = await capturePrompt();
      expect(p).toContain('San Marin Food Bank');
      // The old default was the article-prefixed 'the food bank', which rendered
      // "dispatcher for the the food bank" and taught the model to say it aloud.
      expect(p).not.toMatch(/the the/i);
    });
  });

  it('startCall rejects clearly when keys are absent', async () => {
    // Zero env vars in the test process ⇒ placing a real call must error, not hang.
    const v = new VapiVoice();
    await expect(
      v.startCall(
        { itemId: 'i', recipientId: 'r', script: 's', summary: 'x' },
        {
          id: 'r', name: 'R', type: 'pantry', leadContact: 'L', phone: '+14155550100',
          lat: 0, lng: 0, infrastructure: [], accepts: [], rejects: [],
          typicalWeeklyVolumeLbs: 100, receivedRecentLbs: 0,
        },
        {
          id: 'i', donationId: 'd', item: 'x', qtyLbs: 1, category: 'other',
          hoursToSpoil: 10, needsRefrigeration: false, status: 'pending', attempts: [],
        },
      ),
    ).rejects.toThrow(/VAPI_API_KEY/);
  });
});
