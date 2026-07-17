import { buildApp } from './server.js';
import { D1Store } from './core/memory/d1Store.js';
import { createLlm } from './core/agents/llm.js';
import { createVoice } from './core/voice/caller.js';
import { machineDeps, type PipelineDeps } from './core/pipeline.js';
import { sweepStaleCalls } from './core/voice/dispatchMachine.js';
import { CALL_REPORT_GRACE_MS } from './core/voice/vapi.js';

/**
 * Cloudflare Workers entry point.
 *
 * This exists because the backend no longer holds anything in memory between
 * requests. The old design parked a promise in a Map and waited for a webhook to
 * resolve it, which only works if exactly one process handles both — hence a
 * rented, always-on box. Dispatch state now lives in D1, so any invocation can
 * carry any call forward and the box is unnecessary.
 *
 * Two things still cannot come from process.env:
 *   - D1 is a binding (env.DB), handed to us per-request.
 *   - Everything else (VAPI keys, Gemini, the webhook secret) IS on process.env,
 *     via nodejs_compat + nodejs_compat_populate_process_env, which is why
 *     config.ts's module-scoped ENV and its ten readers survived the port.
 */

export interface Env {
  DB: D1Database;
}

/**
 * Isolates are reused across requests, so cache the wiring — but never cache
 * anything call-specific. `init()` seeds an empty database and is a no-op once
 * seeded; D1Store checks the table rather than trusting an in-process flag,
 * because a flag means nothing when the next request may hit a fresh isolate.
 */
let cached: { store: D1Store; llm: ReturnType<typeof createLlm>; voice: ReturnType<typeof createVoice> } | undefined;

function wiring(env: Env) {
  if (!cached) {
    cached = { store: new D1Store(env.DB), llm: createLlm(), voice: createVoice() };
  }
  return cached;
}

async function resolve(env: Env): Promise<PipelineDeps> {
  const w = wiring(env);
  await w.store.init();
  return { ...w, config: await w.store.getConfig() };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const app = buildApp(() => resolve(env));
    return app.fetch(request);
  },

  /**
   * The report that never came. On Node this was a setTimeout per call; timers
   * do not survive a serverless invocation, so a cron trigger sweeps calls that
   * were placed and never reported and writes them off as no_answer. Without
   * it, one dropped webhook strands a donation at `dispatching` forever.
   */
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const deps = await resolve(env);
    const n = await sweepStaleCalls(CALL_REPORT_GRACE_MS, machineDeps(deps));
    if (n > 0) console.warn(`[sweep] ${n} call(s) never reported; recorded as no_answer`);
  },
};
