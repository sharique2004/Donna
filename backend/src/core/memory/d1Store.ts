import type {
  Donation, Recipient, HistoryEvent, AgentConfig, CallRecord,
} from '../types.js';
import type { MemoryStore } from './store.js';
import { makeSeedRecipients, makeSeedHistory } from '../../seed/recipients.js';
import { DEFAULT_AGENT_CONFIG } from '../../config.js';

/**
 * §5 MemoryStore over Cloudflare D1 — the serverless counterpart to JsonStore.
 *
 * Runs on the Workers runtime: no node:fs/path/url/crypto, no module-level
 * mutable state, no long-lived process. Everything JsonStore kept in RAM (the
 * document, vapi.ts's `pending` map, liveTranscript's buffer) is a table here,
 * so any invocation can serve any request — see d1/schema.sql.
 *
 * Semantics are matched to JsonStore exactly: seed-if-empty on init(), the same
 * reset(), the same shallow weights merge in setConfig(), the same
 * "recipient not found" throws, and the same guarantee that callers never get a
 * handle on shared state. The last one is free here — every read deserializes
 * fresh JSON out of the database, which is a deep clone by construction.
 */

// ---------------------------------------------------------------------------
// Minimal structural D1 types.
//
// Deliberately NOT `@cloudflare/workers-types`: the root tsconfig sets
// `types: ["node"]`, and adding the Workers globals alongside Node's would put
// two conflicting declarations of fetch/crypto/Request into one program and
// redden the Node build. These four interfaces are all of D1 this file touches,
// they are structurally compatible with the real D1Database, and a Worker entry
// can still pass its genuine binding straight in.
// ---------------------------------------------------------------------------

export interface D1Meta {
  changes: number;
  [key: string]: unknown;
}

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  first<T = unknown>(colName: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<Array<D1Result<T>>>;
}

/** Matches liveTranscript.ts — a long or looping call can't grow a buffer without bound. */
const MAX_LIVE_LINES = 200;

type Speaker = 'agent' | 'recipient';
interface LiveLine { speaker: Speaker; text: string }

interface JsonRow { json: string }
interface DonationRow { json: string }
interface HistoryRow {
  id: string;
  recipient_id: string;
  item_id: string | null;
  outcome: string;
  reason: string | null;
  at: string;
}
interface CallRow {
  call_id: string;
  donation_id: string;
  item_id: string;
  recipient_id: string;
  candidate_index: number;
  placed_at: string;
  handled_at: string | null;
  directed: number;
}
interface LiveRow { call_id: string; speaker: string; text: string }

function freshConfig(): AgentConfig {
  return JSON.parse(JSON.stringify(DEFAULT_AGENT_CONFIG)) as AgentConfig;
}

function toHistoryEvent(row: HistoryRow): HistoryEvent {
  const e: HistoryEvent = {
    id: row.id,
    recipientId: row.recipient_id,
    itemId: row.item_id ?? '',
    outcome: row.outcome as HistoryEvent['outcome'],
    at: row.at,
  };
  // `reason` is optional on HistoryEvent; SQL NULL round-trips to absent, not null,
  // so a seeded event and a re-read event deep-equal each other.
  if (row.reason !== null && row.reason !== undefined) e.reason = row.reason;
  return e;
}

function toCallRecord(row: CallRow): CallRecord {
  const c: CallRecord = {
    callId: row.call_id,
    donationId: row.donation_id,
    itemId: row.item_id,
    recipientId: row.recipient_id,
    candidateIndex: row.candidate_index,
    placedAt: row.placed_at,
  };
  if (row.handled_at !== null && row.handled_at !== undefined) c.handledAt = row.handled_at;
  // Only set when true, so a record from D1 compares equal to the same record
  // from JsonStore, where the field is simply absent on an automatic call.
  if (row.directed === 1) c.directed = true;
  return c;
}

export class D1Store implements MemoryStore {
  constructor(private db: D1Database) {}

  // ---- lifecycle -----------------------------------------------------------

  /**
   * Seed recipients/history/config iff the recipients table is empty — the same
   * emptiness test JsonStore applies to its document. No `initialized` memo:
   * each Worker invocation is a fresh isolate, so the memo would never hit; the
   * count query is the guard.
   */
  async init(): Promise<void> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM recipients')
      .first<{ n: number }>();
    if ((row?.n ?? 0) > 0) return;
    await this.seed();
  }

  /** Load seeds (used by init + reset). Mirrors JsonStore.seed(). */
  private async seed(): Promise<void> {
    const statements: D1PreparedStatement[] = [];

    for (const r of makeSeedRecipients()) {
      statements.push(this.recipientUpsert(r));
    }
    for (const e of makeSeedHistory()) {
      statements.push(this.historyInsert(e));
    }
    statements.push(
      this.db
        .prepare('INSERT OR REPLACE INTO config (id, json) VALUES (1, ?)')
        .bind(JSON.stringify(freshConfig())),
    );

    await this.db.batch(statements);
  }

  /**
   * Restore seeds exactly like JsonStore.reset(): recipients and history back to
   * seed, config back to default, donations dropped. Also clears calls and
   * live_lines — JsonStore's equivalents are process memory that a restart
   * discards for free, but here they are durable rows, and a demo reset that
   * left a claimed call behind would let a stale VAPI report resolve against a
   * donation that no longer exists.
   */
  async reset(): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM donations'),
      this.db.prepare('DELETE FROM history'),
      this.db.prepare('DELETE FROM recipients'),
      this.db.prepare('DELETE FROM calls'),
      this.db.prepare('DELETE FROM live_lines'),
      this.db.prepare('DELETE FROM config'),
    ]);
    await this.seed();
  }

  // ---- donations -----------------------------------------------------------

  async saveDonation(d: Donation): Promise<void> {
    await this.db
      .prepare('INSERT OR REPLACE INTO donations (id, status, received_at, json) VALUES (?, ?, ?, ?)')
      .bind(d.id, d.status, d.receivedAt, JSON.stringify(d))
      .run();
  }

  async getDonation(id: string): Promise<Donation | null> {
    const row = await this.db
      .prepare('SELECT json FROM donations WHERE id = ?')
      .bind(id)
      .first<DonationRow>();
    return row ? (JSON.parse(row.json) as Donation) : null;
  }

  async listDonations(): Promise<Donation[]> {
    const { results } = await this.db
      .prepare('SELECT json FROM donations ORDER BY received_at DESC, id ASC')
      .all<DonationRow>();
    return results.map((r) => JSON.parse(r.json) as Donation);
  }

  // ---- recipients ----------------------------------------------------------

  private recipientUpsert(r: Recipient): D1PreparedStatement {
    return this.db
      .prepare('INSERT OR REPLACE INTO recipients (id, json, received_recent_lbs) VALUES (?, ?, ?)')
      .bind(r.id, JSON.stringify(r), r.receivedRecentLbs ?? 0);
  }

  async listRecipients(): Promise<Recipient[]> {
    const { results } = await this.db
      .prepare('SELECT json FROM recipients ORDER BY rowid ASC')
      .all<JsonRow>();
    return results.map((row) => JSON.parse(row.json) as Recipient);
  }

  async getRecipient(id: string): Promise<Recipient | null> {
    const row = await this.db
      .prepare('SELECT json FROM recipients WHERE id = ?')
      .bind(id)
      .first<JsonRow>();
    return row ? (JSON.parse(row.json) as Recipient) : null;
  }

  async updateRecipient(id: string, patch: Partial<Recipient>): Promise<Recipient> {
    const existing = await this.getRecipient(id);
    if (!existing) throw new Error(`Recipient not found: ${id}`);
    // Never let a patch change the primary key.
    const updated: Recipient = { ...existing, ...patch, id: existing.id };
    await this.recipientUpsert(updated).run();
    return updated;
  }

  // ---- history & ledger ----------------------------------------------------

  private historyInsert(e: HistoryEvent): D1PreparedStatement {
    return this.db
      .prepare(
        'INSERT OR REPLACE INTO history (id, recipient_id, item_id, outcome, reason, at) '
        + 'VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(e.id, e.recipientId, e.itemId ?? null, e.outcome, e.reason ?? null, e.at);
  }

  async addHistory(e: HistoryEvent): Promise<void> {
    await this.historyInsert(e).run();
  }

  async listHistory(recipientId?: string): Promise<HistoryEvent[]> {
    // JsonStore returns insertion order, not `at` order (seeded events are
    // deliberately backdated), so order by rowid to preserve that.
    const stmt = recipientId
      ? this.db
        .prepare('SELECT * FROM history WHERE recipient_id = ? ORDER BY rowid ASC')
        .bind(recipientId)
      : this.db.prepare('SELECT * FROM history ORDER BY rowid ASC');
    const { results } = await stmt.all<HistoryRow>();
    return results.map(toHistoryEvent);
  }

  /**
   * Atomic ledger increment. The column is the authority and json_set writes the
   * same number back into the document copy in the same statement, so the two can
   * never drift — and two concurrent credits both land, which a
   * read-modify-write of the JSON could not promise.
   */
  async creditReceived(recipientId: string, lbs: number): Promise<void> {
    const res = await this.db
      .prepare(
        'UPDATE recipients SET '
        + 'received_recent_lbs = received_recent_lbs + ?1, '
        + "json = json_set(json, '$.receivedRecentLbs', received_recent_lbs + ?1) "
        + 'WHERE id = ?2',
      )
      .bind(lbs, recipientId)
      .run();
    if (res.meta.changes === 0) throw new Error(`Recipient not found: ${recipientId}`);
  }

  // ---- config --------------------------------------------------------------

  async getConfig(): Promise<AgentConfig> {
    const row = await this.db.prepare('SELECT json FROM config WHERE id = 1').first<JsonRow>();
    return row ? (JSON.parse(row.json) as AgentConfig) : freshConfig();
  }

  async setConfig(patch: Partial<AgentConfig>): Promise<AgentConfig> {
    const current = await this.getConfig();
    const next: AgentConfig = {
      ...current,
      ...patch,
      // weights merge shallowly so callers can patch a single term.
      weights: { ...current.weights, ...(patch.weights ?? {}) },
    };
    await this.db
      .prepare('INSERT OR REPLACE INTO config (id, json) VALUES (1, ?)')
      .bind(JSON.stringify(next))
      .run();
    return next;
  }

  // ---- in-flight calls -----------------------------------------------------

  async saveCall(call: CallRecord): Promise<void> {
    await this.db
      .prepare(
        'INSERT OR REPLACE INTO calls '
        + '(call_id, donation_id, item_id, recipient_id, candidate_index, placed_at, handled_at, directed) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        call.callId,
        call.donationId,
        call.itemId,
        call.recipientId,
        call.candidateIndex,
        call.placedAt,
        call.handledAt ?? null,
        call.directed ? 1 : 0,
      )
      .run();
  }

  async getCall(callId: string): Promise<CallRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM calls WHERE call_id = ?')
      .bind(callId)
      .first<CallRow>();
    return row ? toCallRecord(row) : null;
  }

  /**
   * The idempotency guard, as one conditional UPDATE.
   *
   * `meta.changes === 1` means this invocation flipped handled_at from NULL and
   * owns the call; 0 means someone else already did (or the call is unknown).
   * SQLite evaluates the predicate and the write in a single atomic statement, so
   * two duplicate end-of-call-reports arriving at once cannot both win — a
   * read-then-write would let both observe NULL, advance the machine twice, and
   * double-dial the next pantry.
   */
  async claimCall(callId: string, at: string): Promise<boolean> {
    const res = await this.db
      .prepare('UPDATE calls SET handled_at = ? WHERE call_id = ? AND handled_at IS NULL')
      .bind(at, callId)
      .run();
    return res.meta.changes > 0;
  }

  async listUnhandledCallsBefore(before: string): Promise<CallRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM calls WHERE handled_at IS NULL AND placed_at < ? ORDER BY placed_at ASC',
      )
      .bind(before)
      .all<CallRow>();
    return results.map(toCallRecord);
  }

  // ---- live transcript -----------------------------------------------------

  /**
   * Mirrors liveTranscript.appendLiveTranscript: VAPI streams rolling partials of
   * the same utterance, so when the new text extends the last line from the same
   * speaker we REPLACE that line instead of appending — otherwise the dashboard
   * renders one growing sentence as a stuttering pile of fragments.
   */
  async appendLiveLine(callId: string, speaker: Speaker, text: string): Promise<void> {
    const last = await this.db
      .prepare('SELECT seq, speaker, text FROM live_lines WHERE call_id = ? ORDER BY seq DESC LIMIT 1')
      .bind(callId)
      .first<{ seq: number; speaker: string; text: string }>();

    if (last && last.speaker === speaker && text.startsWith(last.text)) {
      await this.db
        .prepare('UPDATE live_lines SET text = ? WHERE call_id = ? AND seq = ?')
        .bind(text, callId, last.seq)
        .run();
      return;
    }

    const seq = (last?.seq ?? 0) + 1;
    await this.db.batch([
      this.db
        .prepare('INSERT OR REPLACE INTO live_lines (call_id, seq, speaker, text) VALUES (?, ?, ?, ?)')
        .bind(callId, seq, speaker, text),
      // Trailing cap, equivalent to liveTranscript's `lines.slice(-MAX_LINES)`.
      this.db
        .prepare('DELETE FROM live_lines WHERE call_id = ? AND seq <= ?')
        .bind(callId, seq - MAX_LIVE_LINES),
    ]);
  }

  async getLiveLines(callId: string): Promise<LiveLine[]> {
    const { results } = await this.db
      .prepare('SELECT speaker, text FROM live_lines WHERE call_id = ? ORDER BY seq ASC')
      .bind(callId)
      .all<{ speaker: string; text: string }>();
    return results.map((r) => ({ speaker: r.speaker as Speaker, text: r.text }));
  }

  async listLiveCalls(): Promise<Array<{ callId: string; lines: LiveLine[] }>> {
    const { results } = await this.db
      .prepare('SELECT call_id, speaker, text FROM live_lines ORDER BY call_id ASC, seq ASC')
      .all<LiveRow>();

    const byCall = new Map<string, LiveLine[]>();
    for (const r of results) {
      const lines = byCall.get(r.call_id) ?? [];
      lines.push({ speaker: r.speaker as Speaker, text: r.text });
      byCall.set(r.call_id, lines);
    }
    return [...byCall.entries()].map(([callId, lines]) => ({ callId, lines }));
  }

  async clearLiveLines(callId: string): Promise<void> {
    await this.db.prepare('DELETE FROM live_lines WHERE call_id = ?').bind(callId).run();
  }
}
