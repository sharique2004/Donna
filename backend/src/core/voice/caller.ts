import type {
  DonationItem, OfferDraft, Recipient, CallAttempt, HistoryEvent,
} from '../types.js';
import { ENV } from '../../config.js';
import { SimulatorVoice } from './simulator.js';
import { VapiVoice } from './vapi.js';

/**
 * Agent 3 — the outbound voice provider.
 *
 * `startCall` places the call and returns the id we correlate the report to. It
 * deliberately does NOT wait for the outcome: the old `placeCall` returned a
 * promise that only a webhook could resolve, which forced the whole backend to
 * be one process that never restarts (a promise in instance A's RAM is
 * invisible to instance B). The outcome now arrives via onCallReport.
 *
 * `synthesizeReport` is for providers with no webhook — the simulator decides
 * immediately, and the machine feeds that decision back through exactly the
 * same path a real report takes, so both modes exercise one code path.
 *
 * `setHistory` lets the simulator see the live decline ledger for its 7-day
 * category memory. The live VAPI provider ignores it.
 */
export interface VoiceProvider {
  startCall(offer: OfferDraft, recipient: Recipient, item: DonationItem): Promise<string>;
  synthesizeReport?(
    offer: OfferDraft,
    recipient: Recipient,
    item: DonationItem,
  ): Promise<Pick<CallAttempt, 'outcome' | 'reason' | 'transcript'>>;
  setHistory?(history: HistoryEvent[]): void;
}

export function createVoice(): VoiceProvider {   // env VOICE_PROVIDER: 'sim'(default)|'vapi'
  // VapiVoice compiles/constructs with zero keys; it only needs env when a call
  // is actually placed. All VAPI specifics stay inside vapi.ts.
  if (ENV.voiceProvider === 'vapi') return new VapiVoice();
  return new SimulatorVoice();
}

// The dispatch loop that used to live here is gone. It ranked candidates and
// then `await`ed each placeCall to completion, which meant one process had to
// stay alive for the whole donation and hold the pending promise in RAM. Its
// logic now lives in dispatchMachine.ts as event-driven transitions over state
// in the store, so any invocation can carry a dispatch forward.
