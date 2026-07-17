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

    /** Stub /call, capture the posted body, and abandon the pending promise. */
    async function capturePostedNumber(): Promise<string> {
      let posted: string | undefined;
      vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
        posted = JSON.parse(init.body).customer.number;
        return { ok: true, json: async () => ({ id: 'call_stub' }) } as unknown as Response;
      });
      const v = new VapiVoice();
      // placeCall stays pending until the webhook resolves it, so race the
      // POST against a tick — we only care about what got dialed.
      await Promise.race([
        v.placeCall(OFFER, RECIPIENT, ITEM),
        new Promise((r) => setTimeout(r, 0)),
      ]);
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

  it('placeCall rejects clearly when keys are absent', async () => {
    // Zero env vars in the test process ⇒ placing a real call must error, not hang.
    const v = new VapiVoice();
    await expect(
      v.placeCall(
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
