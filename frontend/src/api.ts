// Typed fetch client matching ARCHITECTURE §9 exactly.
// All calls hit the Vite dev proxy (/api → localhost:8787). No direct URLs.

import type {
  AgentConfig, CallLogEntry, Channel, DirectedCallResponse, Donation, EnrichedDonation,
  HealthResponse, HistoryEvent, LiveResponse, ManagerReply,
  ManualCallInput, RankResponse, RankedRecipient, Recipient, Weights,
} from './types';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  let body: any = undefined;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!res.ok) {
    const msg = (body && typeof body === 'object' && body.error) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

// Some routes may return either the enriched envelope or a bare Donation.
// Normalize to the enriched shape so callers have one contract.
function asEnriched(raw: any): EnrichedDonation {
  if (raw && raw.donation) return raw as EnrichedDonation;
  return { donation: raw as Donation, rankings: {} };
}

export const api = {
  health: () => request<HealthResponse>('/health'),

  ingest: (channel: Channel, contact: string, rawText: string) =>
    request<any>('/donations', {
      method: 'POST',
      body: JSON.stringify({ channel, contact, rawText }),
    }).then(asEnriched),

  listDonations: () => request<Donation[]>('/donations'),

  // §D.5 / §F — flattened, newest-first call log for the Outbound feed.
  getCalls: () => request<CallLogEntry[]>('/calls'),

  getDonation: (id: string) =>
    request<any>(`/donations/${id}`).then(asEnriched),

  dispatch: (id: string) =>
    request<any>(`/donations/${id}/dispatch`, { method: 'POST', body: '{}' })
      .then((raw) => (raw && raw.donation ? (raw.donation as Donation) : (raw as Donation))),

  /**
   * Release a donation held at `awaiting_triage` — the human gate. Returns 202
   * immediately; the call loop runs in the background and persists as it goes,
   * so the caller follows along via getDonation rather than holding a request
   * open for minutes of real phone calls.
   */
  approve: (id: string) =>
    request<{ ok: boolean; status: string; donationId: string }>(
      `/donations/${id}/approve`,
      { method: 'POST', body: '{}' },
    ),

  /** Calls on the phone right now, with transcripts as they are spoken. */
  live: () => request<LiveResponse>('/live'),

  rank: (itemId: string, weights?: Weights) =>
    request<any>(`/items/${itemId}/rank`, {
      method: 'POST',
      body: JSON.stringify(weights ? { weights } : {}),
    }).then((raw): RankResponse => {
      if (Array.isArray(raw)) return { rankings: raw as RankedRecipient[], explanation: '' };
      return {
        rankings: (raw.rankings ?? raw.ranked ?? []) as RankedRecipient[],
        explanation: raw.explanation ?? '',
        warnings: raw.warnings,
      };
    }),

  // §G.3 — directed single call, bypassing the ranking loop. 404 unknown ids,
  // 409 if the item is not pending. Returns { item, attempt }.
  callRecipient: (itemId: string, recipientId: string) =>
    request<DirectedCallResponse>(`/items/${itemId}/call/${recipientId}`, {
      method: 'POST',
      body: '{}',
    }),

  // §G.3 — human-logged call (no voice provider); recorded exactly like an agent
  // call but flagged manual. Same 404/409 rules. Returns { item, attempt }.
  logManualCall: (itemId: string, recipientId: string, input: ManualCallInput) =>
    request<DirectedCallResponse>(`/items/${itemId}/manual/${recipientId}`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listRecipients: () => request<Recipient[]>('/recipients'),

  getRecipient: (id: string) =>
    request<Recipient & { history?: HistoryEvent[] }>(`/recipients/${id}`),

  getConfig: () => request<AgentConfig>('/config'),

  putConfig: (patch: Partial<AgentConfig>) =>
    request<AgentConfig>('/config', { method: 'PUT', body: JSON.stringify(patch) }),

  managerChat: (message: string) =>
    request<ManagerReply>('/manager/chat', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  reset: () => request<any>('/demo/reset', { method: 'POST', body: '{}' }),

  canned: () => request<any>('/demo/canned', { method: 'POST', body: '{}' }).then(asEnriched),
};
