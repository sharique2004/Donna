// MUST be first: it populates process.env from backend/.env, and config.ts
// computes its ENV constant at module-evaluation time.
import './loadEnvNode.js';
import { serve } from '@hono/node-server';
import { ENV } from './config.js';
import { buildApp } from './server.js';
import type { PipelineDeps } from './core/pipeline.js';
import { createStore } from './core/memory/store.js';
import { createLlm } from './core/agents/llm.js';
import { createVoice } from './core/voice/caller.js';
import { sweepStaleCalls, type MachineDeps } from './core/voice/dispatchMachine.js';
import { machineDeps } from './core/pipeline.js';
import { CALL_REPORT_GRACE_MS } from './core/voice/vapi.js';

/**
 * Node entry point. The Cloudflare entry is src/worker.ts; server.ts itself is
 * runtime-neutral so both can share it.
 *
 * Kept for local development and for anyone who would rather run this on a box
 * than on Workers — the JSON store and a filesystem come along for free here.
 */

let singletons: Omit<PipelineDeps, 'config'> | undefined;
let initP: Promise<void> | undefined;

function resolve(): Promise<PipelineDeps> {
  if (!singletons) {
    singletons = { store: createStore(), llm: createLlm(), voice: createVoice() };
  }
  const s = singletons;
  if (!initP) initP = Promise.resolve(s.store.init());
  return initP.then(async () => ({ ...s, config: await s.store.getConfig() }));
}

export const app = buildApp(resolve);

/**
 * The stale-call sweep. On Workers this is a cron trigger; here it is an
 * interval, because a dropped webhook must never strand a donation at
 * `dispatching` forever. This replaces the old per-call setTimeout that used to
 * live inside vapi.ts.
 */
const SWEEP_EVERY_MS = 60_000;

async function sweep(): Promise<void> {
  try {
    const deps = await resolve();
    const n = await sweepStaleCalls(CALL_REPORT_GRACE_MS, machineDeps(deps) as MachineDeps);
    if (n > 0) console.warn(`[sweep] ${n} call(s) never reported; recorded as no_answer`);
  } catch (e) {
    console.error('[sweep] failed:', e instanceof Error ? e.message : e);
  }
}

// Construct singletons + store.init() BEFORE serving (contract §9).
resolve()
  .then(() => {
    serve({ fetch: app.fetch, port: ENV.port }, (info) => {
      // eslint-disable-next-line no-console
      console.log(`Donna backend listening on http://localhost:${info.port}`);
    });
    setInterval(() => { void sweep(); }, SWEEP_EVERY_MS).unref();
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start Donna backend:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
