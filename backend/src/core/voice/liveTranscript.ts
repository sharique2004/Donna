/**
 * In-flight transcript buffer, keyed by VAPI call id.
 *
 * VAPI streams `transcript` messages while a call is happening; the finished
 * transcript only arrives in the end-of-call-report. The stage dashboard needs
 * to show words as they are spoken, so we buffer partials here and the UI polls
 * them. Once the call ends, the durable transcript lives on the CallAttempt (or
 * the donation, for inbound) and the buffer is dropped.
 *
 * Deliberately in-memory: this is ephemeral display data for a call that is
 * happening right now, on a single long-lived backend. It is one of the things
 * that would need to move into Postgres if the backend ever goes serverless —
 * same constraint as vapi.ts's `pending` map.
 */

export interface LiveLine {
  speaker: 'agent' | 'recipient';
  text: string;
}

/** callId → lines so far. */
const live = new Map<string, LiveLine[]>();

/** Cap per call so a long or looping call can't grow this without bound. */
const MAX_LINES = 200;

export function appendLiveTranscript(callId: string, line: LiveLine): void {
  const lines = live.get(callId) ?? [];
  // VAPI sends rolling partials for the same utterance — replace the previous
  // line from the same speaker when the new text extends it, so the dashboard
  // shows one growing sentence instead of a stuttering pile of fragments.
  const last = lines[lines.length - 1];
  if (last && last.speaker === line.speaker && line.text.startsWith(last.text)) {
    lines[lines.length - 1] = line;
  } else {
    lines.push(line);
  }
  live.set(callId, lines.slice(-MAX_LINES));
}

export function getLiveTranscript(callId: string): LiveLine[] {
  return live.get(callId) ?? [];
}

/** All in-flight calls — the dashboard's "who is on the phone right now". */
export function listLiveCalls(): Array<{ callId: string; lines: LiveLine[] }> {
  return [...live.entries()].map(([callId, lines]) => ({ callId, lines }));
}

export function clearLiveTranscript(callId: string): void {
  live.delete(callId);
}
