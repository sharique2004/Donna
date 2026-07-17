import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type {
  Donation, Recipient, HistoryEvent, AgentConfig, CallRecord,
} from '../types.js';
import type { MemoryStore } from './store.js';
import { makeSeedRecipients, makeSeedHistory } from '../../seed/recipients.js';
import { DEFAULT_AGENT_CONFIG } from '../../config.js';

type Speaker = 'agent' | 'recipient';
interface LiveLine { speaker: Speaker; text: string }

/** Matches d1Store/liveTranscript — a long or looping call can't grow a buffer without bound. */
const MAX_LIVE_LINES = 200;

interface DbDocument {
  recipients: Recipient[];
  donations: Donation[];
  history: HistoryEvent[];
  config: AgentConfig;
  /** In-flight/placed calls — dispatch state, so a restart mid-dispatch keeps them. */
  calls?: CallRecord[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
// src/core/memory → backend/data/db.json  (dist/core/memory → backend/data/db.json)
const DEFAULT_DB_PATH = resolve(HERE, '../../../data/db.json');

const WRITE_DEBOUNCE_MS = 200;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function freshConfig(): AgentConfig {
  return clone(DEFAULT_AGENT_CONFIG);
}

/**
 * §5 default MemoryStore — an in-memory document mirrored to backend/data/db.json.
 * Reads are served from memory; every mutation schedules a debounced (~200ms)
 * write-through. Seeds from seed/recipients.ts when the file is empty/absent, and
 * reset() restores those seeds.
 *
 * `dbPath` is injectable so tests can point at a throwaway file.
 */
export class JsonStore implements MemoryStore {
  private readonly dbPath: string;

  private recipients = new Map<string, Recipient>();
  private donations = new Map<string, Donation>();
  private history: HistoryEvent[] = [];
  private config: AgentConfig = freshConfig();
  private calls = new Map<string, CallRecord>();

  /**
   * Live transcript lines, callId → lines. Deliberately in-memory and NOT part of
   * the on-disk document: ephemeral display data for a call happening right now,
   * on a single long-lived backend. Mirrors the old voice/liveTranscript module.
   */
  private live = new Map<string, LiveLine[]>();

  private initialized = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrite: Promise<void> | null = null;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    let doc: DbDocument | null = null;
    try {
      const raw = await fs.readFile(this.dbPath, 'utf8');
      const trimmed = raw.trim();
      if (trimmed.length > 0) doc = JSON.parse(trimmed) as DbDocument;
    } catch {
      doc = null; // missing/unreadable ⇒ seed fresh
    }

    if (!doc || !Array.isArray(doc.recipients) || doc.recipients.length === 0) {
      await this.seed();
    } else {
      this.loadDoc(doc);
    }
    this.initialized = true;
  }

  private loadDoc(doc: DbDocument): void {
    this.recipients = new Map((doc.recipients ?? []).map((r) => [r.id, r]));
    this.donations = new Map((doc.donations ?? []).map((d) => [d.id, d]));
    this.history = Array.isArray(doc.history) ? doc.history : [];
    this.config = doc.config ?? freshConfig();
    // Backward compatible: a db.json written before calls existed has no `calls` key.
    this.calls = new Map((doc.calls ?? []).map((c) => [c.callId, c]));
    this.live.clear();
  }

  /** Load seeds into memory and persist immediately (used by init + reset). */
  private async seed(): Promise<void> {
    this.recipients = new Map(makeSeedRecipients().map((r) => [r.id, r]));
    this.donations = new Map();
    this.history = makeSeedHistory();
    this.config = freshConfig();
    // reset() routes through here, so calls and live lines are cleared too: a demo
    // reset that left a claimed call behind would let a stale VAPI report resolve
    // against a donation that no longer exists.
    this.calls = new Map();
    this.live.clear();
    await this.flushNow();
  }

  // ---- donations -----------------------------------------------------------

  async saveDonation(d: Donation): Promise<void> {
    this.donations.set(d.id, clone(d));
    this.scheduleWrite();
  }

  async getDonation(id: string): Promise<Donation | null> {
    const d = this.donations.get(id);
    return d ? clone(d) : null;
  }

  async listDonations(): Promise<Donation[]> {
    return Array.from(this.donations.values()).map(clone);
  }

  // ---- recipients ----------------------------------------------------------

  async listRecipients(): Promise<Recipient[]> {
    return Array.from(this.recipients.values()).map(clone);
  }

  async getRecipient(id: string): Promise<Recipient | null> {
    const r = this.recipients.get(id);
    return r ? clone(r) : null;
  }

  async updateRecipient(id: string, patch: Partial<Recipient>): Promise<Recipient> {
    const existing = this.recipients.get(id);
    if (!existing) throw new Error(`Recipient not found: ${id}`);
    // Never let a patch change the primary key.
    const updated: Recipient = { ...existing, ...patch, id: existing.id };
    this.recipients.set(id, updated);
    this.scheduleWrite();
    return clone(updated);
  }

  // ---- history & ledger ----------------------------------------------------

  async addHistory(e: HistoryEvent): Promise<void> {
    this.history.push(clone(e));
    this.scheduleWrite();
  }

  async listHistory(recipientId?: string): Promise<HistoryEvent[]> {
    const all = recipientId
      ? this.history.filter((e) => e.recipientId === recipientId)
      : this.history;
    return all.map(clone);
  }

  async creditReceived(recipientId: string, lbs: number): Promise<void> {
    const existing = this.recipients.get(recipientId);
    if (!existing) throw new Error(`Recipient not found: ${recipientId}`);
    existing.receivedRecentLbs = (existing.receivedRecentLbs ?? 0) + lbs;
    this.scheduleWrite();
  }

  // ---- config --------------------------------------------------------------

  async getConfig(): Promise<AgentConfig> {
    return clone(this.config);
  }

  async setConfig(patch: Partial<AgentConfig>): Promise<AgentConfig> {
    this.config = {
      ...this.config,
      ...patch,
      // weights merge shallowly so callers can patch a single term.
      weights: { ...this.config.weights, ...(patch.weights ?? {}) },
    };
    this.scheduleWrite();
    return clone(this.config);
  }

  // ---- in-flight calls -----------------------------------------------------

  async saveCall(call: CallRecord): Promise<void> {
    this.calls.set(call.callId, clone(call));
    this.scheduleWrite();
  }

  async getCall(callId: string): Promise<CallRecord | null> {
    const c = this.calls.get(callId);
    return c ? clone(c) : null;
  }

  /**
   * The idempotency guard. d1Store does this as one conditional UPDATE because two
   * duplicate end-of-call-reports can land in different Worker isolates at once;
   * here a single Node process runs one task to completion between awaits, so this
   * check-then-set cannot interleave and a plain read-then-write is equivalent.
   */
  async claimCall(callId: string, at: string): Promise<boolean> {
    const existing = this.calls.get(callId);
    if (!existing || existing.handledAt) return false;
    existing.handledAt = at;
    this.scheduleWrite();
    return true;
  }

  async listUnhandledCallsBefore(before: string): Promise<CallRecord[]> {
    return Array.from(this.calls.values())
      .filter((c) => !c.handledAt && c.placedAt < before)
      .sort((a, b) => (a.placedAt < b.placedAt ? -1 : a.placedAt > b.placedAt ? 1 : 0))
      .map(clone);
  }

  // ---- live transcript -----------------------------------------------------

  /**
   * Mirrors liveTranscript.appendLiveTranscript: VAPI streams rolling partials of
   * the same utterance, so when the new text extends the last line from the same
   * speaker we REPLACE that line instead of appending — otherwise the dashboard
   * renders one growing sentence as a stuttering pile of fragments.
   */
  async appendLiveLine(callId: string, speaker: Speaker, text: string): Promise<void> {
    const lines = this.live.get(callId) ?? [];
    const last = lines[lines.length - 1];
    if (last && last.speaker === speaker && text.startsWith(last.text)) {
      lines[lines.length - 1] = { speaker, text };
    } else {
      lines.push({ speaker, text });
    }
    this.live.set(callId, lines.slice(-MAX_LIVE_LINES));
  }

  async getLiveLines(callId: string): Promise<LiveLine[]> {
    return (this.live.get(callId) ?? []).map(clone);
  }

  async listLiveCalls(): Promise<Array<{ callId: string; lines: LiveLine[] }>> {
    return [...this.live.entries()].map(([callId, lines]) => ({
      callId,
      lines: lines.map(clone),
    }));
  }

  async clearLiveLines(callId: string): Promise<void> {
    this.live.delete(callId);
  }

  // ---- reset ---------------------------------------------------------------

  async reset(): Promise<void> {
    await this.seed();
  }

  // ---- persistence ---------------------------------------------------------

  private snapshot(): DbDocument {
    return {
      recipients: Array.from(this.recipients.values()),
      donations: Array.from(this.donations.values()),
      history: this.history,
      config: this.config,
      calls: Array.from(this.calls.values()),
    };
  }

  /** Debounced trailing write-through (~200ms). */
  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flushNow();
    }, WRITE_DEBOUNCE_MS);
    // Do not keep the event loop alive purely for a pending flush.
    if (typeof this.writeTimer === 'object' && this.writeTimer && 'unref' in this.writeTimer) {
      (this.writeTimer as { unref: () => void }).unref();
    }
  }

  /**
   * Flush the current snapshot to disk now, cancelling any pending debounce.
   * Not part of the MemoryStore interface — exposed for deterministic tests and
   * graceful shutdown.
   */
  async flushNow(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const data = JSON.stringify(this.snapshot(), null, 2);
    const dir = dirname(this.dbPath);
    // Serialize concurrent flushes so writes never interleave.
    this.pendingWrite = (this.pendingWrite ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(this.dbPath, data, 'utf8');
      });
    await this.pendingWrite;
  }
}
