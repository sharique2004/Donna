import type {
  Donation, Recipient, HistoryEvent, AgentConfig, CallRecord,
} from '../types.js';
import { ENV } from '../../config.js';
import { JsonStore } from './jsonStore.js';
import { InsforgeStore } from './insforgeStore.js';

export interface MemoryStore {
  init(): Promise<void>;                       // load/create; seed if empty
  // donations
  saveDonation(d: Donation): Promise<void>;
  getDonation(id: string): Promise<Donation | null>;
  listDonations(): Promise<Donation[]>;
  // recipients
  listRecipients(): Promise<Recipient[]>;
  getRecipient(id: string): Promise<Recipient | null>;
  updateRecipient(id: string, patch: Partial<Recipient>): Promise<Recipient>;
  // history & ledger
  addHistory(e: HistoryEvent): Promise<void>;
  listHistory(recipientId?: string): Promise<HistoryEvent[]>;
  creditReceived(recipientId: string, lbs: number): Promise<void>;
  // config
  getConfig(): Promise<AgentConfig>;
  setConfig(patch: Partial<AgentConfig>): Promise<AgentConfig>;
  reset(): Promise<void>;                      // restore seeds (demo reset)

  // ---- in-flight calls (replaces vapi.ts's in-memory `pending` map) --------
  /** Record a placed call so a later, unrelated invocation can resolve it. */
  saveCall(call: CallRecord): Promise<void>;
  getCall(callId: string): Promise<CallRecord | null>;
  /**
   * Claim a call for handling. Returns false if it was already handled — the
   * idempotency guard against VAPI's duplicate end-of-call-reports, which would
   * otherwise advance the machine twice and double-dial the next pantry.
   */
  claimCall(callId: string, at: string): Promise<boolean>;
  /** Calls placed before `before` that never got a report — for the cron sweep. */
  listUnhandledCallsBefore(before: string): Promise<CallRecord[]>;

  // ---- live transcript (ephemeral display data for a call in progress) -----
  appendLiveLine(callId: string, speaker: 'agent' | 'recipient', text: string): Promise<void>;
  getLiveLines(callId: string): Promise<Array<{ speaker: 'agent' | 'recipient'; text: string }>>;
  listLiveCalls(): Promise<Array<{ callId: string; lines: Array<{ speaker: 'agent' | 'recipient'; text: string }> }>>;
  clearLiveLines(callId: string): Promise<void>;
}

/**
 * Factory keyed on DB_PROVIDER (default 'json'). The InsForge store is imported
 * lazily so keyless mock-mode never touches it; it only throws if actually selected
 * without the required env.
 */
export function createStore(): MemoryStore {
  // InsforgeStore compiles and imports keyless; its constructor is what throws when
  // selected without env, so importing it here is always safe.
  if (ENV.dbProvider === 'insforge') return new InsforgeStore();
  return new JsonStore();
}
