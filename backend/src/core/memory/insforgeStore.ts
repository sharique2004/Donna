import type {
  Donation, Recipient, HistoryEvent, AgentConfig, CallRecord,
} from '../types.js';
import type { MemoryStore } from './store.js';
import { ENV } from '../../config.js';
import { makeSeedRecipients, makeSeedHistory } from '../../seed/recipients.js';
import { DEFAULT_AGENT_CONFIG } from '../../config.js';

/**
 * §5 live-mode MemoryStore over the InsForge records REST API.
 *
 * ALL InsForge-specific details (auth header, endpoint shape, row mapping between
 * camelCase domain objects and snake_case jsonb columns) are contained in this file.
 * It compiles and imports with zero env; the constructor is the only thing that
 * throws, and only when DB_PROVIDER=insforge is actually selected without the
 * required INSFORGE_BASE_URL / INSFORGE_API_KEY.
 *
 * Tables (see insforge/schema.sql, WP-H): `recipients`, `donations`,
 * `history_events`, `agent_config`. Donation line-items + call attempts are stored
 * as jsonb on the donation row (`items` column) to keep one round-trip per donation.
 * This path is NOT exercised in v1 CI — it must compile and be honestly documented.
 */

const CONFIG_ROW_ID = 'singleton';

interface RecordsResponse<T> {
  records?: T[];
  data?: T[];
}

export class InsforgeStore implements MemoryStore {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    const baseUrl = ENV.insforgeBaseUrl.replace(/\/+$/, '');
    const apiKey = ENV.insforgeApiKey;
    if (!baseUrl || !apiKey) {
      throw new Error(
        'InsforgeStore requires INSFORGE_BASE_URL and INSFORGE_API_KEY when DB_PROVIDER=insforge.',
      );
    }
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async init(): Promise<void> {
    // Seed recipients + history if the recipients table is empty.
    const existing = await this.listRecipients();
    if (existing.length === 0) {
      for (const r of makeSeedRecipients()) {
        await this.post('recipients', toRecipientRow(r));
      }
      for (const e of makeSeedHistory()) {
        await this.post('history_events', toHistoryRow(e));
      }
    }
    const cfg = await this.fetchConfigRow();
    if (!cfg) {
      await this.post('agent_config', {
        id: CONFIG_ROW_ID,
        config: DEFAULT_AGENT_CONFIG,
      });
    }
  }

  // ---- HTTP helpers (InsForge records REST) --------------------------------

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private url(table: string, query = ''): string {
    return `${this.baseUrl}/api/database/records/${table}${query}`;
  }

  private async get<T>(table: string, query = ''): Promise<T[]> {
    const res = await fetch(this.url(table, query), { headers: this.headers() });
    if (!res.ok) throw new Error(`InsForge GET ${table} failed: ${res.status}`);
    const body = (await res.json()) as RecordsResponse<T> | T[];
    if (Array.isArray(body)) return body;
    return body.records ?? body.data ?? [];
  }

  private async post<T extends object>(table: string, row: T): Promise<void> {
    // InsForge records API is PostgREST-backed: an INSERT body is the row object
    // itself (or an array of rows), NOT a {records:[...]} envelope. Verified
    // empirically — the envelope 400s with PGRST204 ("Could not find the
    // 'records' column"). Send the bare row.
    const res = await fetch(this.url(table), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`InsForge POST ${table} failed: ${res.status}`);
  }

  private async patch<T extends object>(table: string, id: string, row: T): Promise<void> {
    const res = await fetch(this.url(table, `?id=eq.${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`InsForge PATCH ${table} failed: ${res.status}`);
  }

  private async delete(table: string, query: string): Promise<void> {
    const res = await fetch(this.url(table, query), {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`InsForge DELETE ${table} failed: ${res.status}`);
  }

  // ---- donations -----------------------------------------------------------

  async saveDonation(d: Donation): Promise<void> {
    const existing = await this.get<DonationRow>(
      'donations', `?id=eq.${encodeURIComponent(d.id)}`,
    );
    const row = toDonationRow(d);
    if (existing.length > 0) await this.patch('donations', d.id, row);
    else await this.post('donations', row);
  }

  async getDonation(id: string): Promise<Donation | null> {
    const rows = await this.get<DonationRow>(
      'donations', `?id=eq.${encodeURIComponent(id)}`,
    );
    return rows.length > 0 ? fromDonationRow(rows[0]) : null;
  }

  async listDonations(): Promise<Donation[]> {
    const rows = await this.get<DonationRow>('donations');
    return rows.map(fromDonationRow);
  }

  // ---- recipients ----------------------------------------------------------

  async listRecipients(): Promise<Recipient[]> {
    const rows = await this.get<RecipientRow>('recipients');
    return rows.map(fromRecipientRow);
  }

  async getRecipient(id: string): Promise<Recipient | null> {
    const rows = await this.get<RecipientRow>(
      'recipients', `?id=eq.${encodeURIComponent(id)}`,
    );
    return rows.length > 0 ? fromRecipientRow(rows[0]) : null;
  }

  async updateRecipient(id: string, patch: Partial<Recipient>): Promise<Recipient> {
    const current = await this.getRecipient(id);
    if (!current) throw new Error(`Recipient not found: ${id}`);
    const updated: Recipient = { ...current, ...patch, id: current.id };
    await this.patch('recipients', id, toRecipientRow(updated));
    return updated;
  }

  // ---- history & ledger ----------------------------------------------------

  async addHistory(e: HistoryEvent): Promise<void> {
    await this.post('history_events', toHistoryRow(e));
  }

  async listHistory(recipientId?: string): Promise<HistoryEvent[]> {
    const query = recipientId
      ? `?recipient_id=eq.${encodeURIComponent(recipientId)}`
      : '';
    const rows = await this.get<HistoryRow>('history_events', query);
    return rows.map(fromHistoryRow);
  }

  async creditReceived(recipientId: string, lbs: number): Promise<void> {
    const current = await this.getRecipient(recipientId);
    if (!current) throw new Error(`Recipient not found: ${recipientId}`);
    await this.patch('recipients', recipientId, {
      received_recent_lbs: (current.receivedRecentLbs ?? 0) + lbs,
    });
  }

  // ---- config --------------------------------------------------------------

  private async fetchConfigRow(): Promise<AgentConfig | null> {
    const rows = await this.get<{ id: string; config: AgentConfig }>(
      'agent_config', `?id=eq.${CONFIG_ROW_ID}`,
    );
    return rows.length > 0 ? rows[0].config : null;
  }

  async getConfig(): Promise<AgentConfig> {
    const cfg = await this.fetchConfigRow();
    return cfg ?? { ...DEFAULT_AGENT_CONFIG };
  }

  async setConfig(patch: Partial<AgentConfig>): Promise<AgentConfig> {
    const current = await this.getConfig();
    const next: AgentConfig = {
      ...current,
      ...patch,
      weights: { ...current.weights, ...(patch.weights ?? {}) },
    };
    const existing = await this.fetchConfigRow();
    if (existing) await this.patch('agent_config', CONFIG_ROW_ID, { config: next });
    else await this.post('agent_config', { id: CONFIG_ROW_ID, config: next });
    return next;
  }

  // ---- reset ---------------------------------------------------------------

  async reset(): Promise<void> {
    await this.delete('donations', '?id=neq.__none__');
    await this.delete('history_events', '?id=neq.__none__');
    await this.delete('recipients', '?id=neq.__none__');
    for (const r of makeSeedRecipients()) await this.post('recipients', toRecipientRow(r));
    for (const e of makeSeedHistory()) await this.post('history_events', toHistoryRow(e));
    await this.setConfig({ ...DEFAULT_AGENT_CONFIG });
  }

  // ---- in-flight calls & live transcript (NOT IMPLEMENTED) -----------------
  //
  // PRD §11: this store is inert — the InsForge AI gateway 404s, the calls /
  // live_lines schema was never applied, and nothing selects DB_PROVIDER=insforge.
  // Rather than write an unexercised implementation against tables that do not
  // exist (which would silently drop dispatch state), these throw. Anyone who does
  // select this store gets an honest, named failure instead of lost calls.

  private notImplemented(method: string): never {
    throw new Error(
      `InsforgeStore.${method} is not implemented: the InsForge backend has no calls/`
      + 'live_lines schema (PRD §11). Use DB_PROVIDER=json or the D1 store instead.',
    );
  }

  async saveCall(_call: CallRecord): Promise<void> {
    this.notImplemented('saveCall');
  }

  async getCall(_callId: string): Promise<CallRecord | null> {
    this.notImplemented('getCall');
  }

  async claimCall(_callId: string, _at: string): Promise<boolean> {
    this.notImplemented('claimCall');
  }

  async listUnhandledCallsBefore(_before: string): Promise<CallRecord[]> {
    this.notImplemented('listUnhandledCallsBefore');
  }

  async appendLiveLine(
    _callId: string, _speaker: 'agent' | 'recipient', _text: string,
  ): Promise<void> {
    this.notImplemented('appendLiveLine');
  }

  async getLiveLines(
    _callId: string,
  ): Promise<Array<{ speaker: 'agent' | 'recipient'; text: string }>> {
    this.notImplemented('getLiveLines');
  }

  async listLiveCalls(): Promise<Array<{
    callId: string; lines: Array<{ speaker: 'agent' | 'recipient'; text: string }>;
  }>> {
    this.notImplemented('listLiveCalls');
  }

  async clearLiveLines(_callId: string): Promise<void> {
    this.notImplemented('clearLiveLines');
  }
}

// ---- row mapping (camelCase domain ⇄ snake_case jsonb columns) -------------

interface RecipientRow {
  id: string; name: string; type: string;
  lead_contact: string; phone: string;
  lat: number; lng: number;
  infrastructure: unknown; accepts: unknown; rejects: unknown;
  typical_weekly_volume_lbs: number;
  best_call_window?: string | null;
  received_recent_lbs: number;
  notes?: string | null;
}

function toRecipientRow(r: Recipient): RecipientRow {
  return {
    id: r.id, name: r.name, type: r.type,
    lead_contact: r.leadContact, phone: r.phone,
    lat: r.lat, lng: r.lng,
    infrastructure: r.infrastructure, accepts: r.accepts, rejects: r.rejects,
    typical_weekly_volume_lbs: r.typicalWeeklyVolumeLbs,
    best_call_window: r.bestCallWindow ?? null,
    received_recent_lbs: r.receivedRecentLbs,
    notes: r.notes ?? null,
  };
}

function fromRecipientRow(row: RecipientRow): Recipient {
  return {
    id: row.id, name: row.name, type: row.type as Recipient['type'],
    leadContact: row.lead_contact, phone: row.phone,
    lat: row.lat, lng: row.lng,
    infrastructure: (row.infrastructure as Recipient['infrastructure']) ?? [],
    accepts: (row.accepts as Recipient['accepts']) ?? [],
    rejects: (row.rejects as Recipient['rejects']) ?? [],
    typicalWeeklyVolumeLbs: row.typical_weekly_volume_lbs,
    bestCallWindow: row.best_call_window ?? undefined,
    receivedRecentLbs: row.received_recent_lbs,
    notes: row.notes ?? undefined,
  };
}

interface HistoryRow {
  id: string; recipient_id: string; item_id: string;
  outcome: string; reason?: string | null; at: string;
}

function toHistoryRow(e: HistoryEvent): HistoryRow {
  return {
    id: e.id, recipient_id: e.recipientId, item_id: e.itemId,
    outcome: e.outcome, reason: e.reason ?? null, at: e.at,
  };
}

function fromHistoryRow(row: HistoryRow): HistoryEvent {
  return {
    id: row.id, recipientId: row.recipient_id, itemId: row.item_id,
    outcome: row.outcome as HistoryEvent['outcome'],
    reason: row.reason ?? undefined, at: row.at,
  };
}

interface DonationRow {
  id: string; source_channel: string; source_contact: string;
  received_at: string; raw_text: string; status: string;
  donor_name?: string | null; pickup_location?: string | null;
  pickup_lat?: number | null; pickup_lng?: number | null;
  items: unknown; donor_message?: string | null;
}

function toDonationRow(d: Donation): DonationRow {
  return {
    id: d.id, source_channel: d.sourceChannel, source_contact: d.sourceContact,
    received_at: d.receivedAt, raw_text: d.rawText, status: d.status,
    donor_name: d.donorName ?? null, pickup_location: d.pickupLocation ?? null,
    pickup_lat: d.pickupLat ?? null, pickup_lng: d.pickupLng ?? null,
    items: d.items, donor_message: d.donorMessage ?? null,
  };
}

function fromDonationRow(row: DonationRow): Donation {
  return {
    id: row.id,
    sourceChannel: row.source_channel as Donation['sourceChannel'],
    sourceContact: row.source_contact,
    receivedAt: row.received_at, rawText: row.raw_text,
    status: row.status as Donation['status'],
    donorName: row.donor_name ?? undefined,
    pickupLocation: row.pickup_location ?? undefined,
    pickupLat: row.pickup_lat ?? undefined,
    pickupLng: row.pickup_lng ?? undefined,
    items: (row.items as Donation['items']) ?? [],
    donorMessage: row.donor_message ?? undefined,
  };
}
