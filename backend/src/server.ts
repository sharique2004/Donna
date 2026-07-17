import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { pathToFileURL } from 'node:url';
import { ENV } from './config.js';
import type {
  Donation, DonationItem, RankedRecipient, Weights, AgentConfig,
} from './core/types.js';
import { createStore, type MemoryStore } from './core/memory/store.js';
import { createLlm, type LlmClient } from './core/agents/llm.js';
import { LlmMock } from './core/agents/llmMock.js';
import { createVoice, type VoiceProvider } from './core/voice/caller.js';
import {
  ingestDonation, dispatchDonation, rankItem,
  directedCall, manualCall,
  type PipelineDeps, type DirectedCallError, type ManualCallInput,
} from './core/pipeline.js';
import type { CallOutcome } from './core/types.js';
import { managerChat } from './core/agents/manager.js';
import { explainRanking } from './core/scoring/explain.js';
import { simulateAB } from './core/scoring/equity.js';
import { parseWebhook, resolveCall } from './core/voice/vapi.js';
import { buildInboundAssistant, isInboundCall, transcriptToRawText } from './core/voice/inbound.js';
import {
  appendLiveTranscript, clearLiveTranscript, getLiveTranscript, listLiveCalls,
} from './core/voice/liveTranscript.js';
import { CANNED_SCENARIO } from './seed/scenarios.js';

// ---------------------------------------------------------------------------
// Shared shapes returned by the HTTP layer (not domain types; contract §9).
// ---------------------------------------------------------------------------
export interface EnrichedDonation {
  donation: Donation;
  rankings: Record<string, RankedRecipient[]>;
  warnings?: string[];
}

export interface ServerDeps {
  store: MemoryStore;
  llm: LlmClient;
  voice: VoiceProvider;
}

// §D.5 — a flattened call-log row: one per CallAttempt, tagged with its donation
// and item so the client can render call logs as first-class DB records.
export type CallLogEntry = {
  donationId: string;
  itemId: string;
  itemName: string;
} & DonationItem['attempts'][number];

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// §D.4 — live-provider guard. Wraps a live LlmClient with an 8s timeout and a
// graceful degrade to the deterministic mock on timeout/error, recording that a
// degrade happened so the route can surface a warning. The mock default and the
// canned demo never touch this path.
const LIVE_LLM_TIMEOUT_MS = 8000;

class DegradingLlm implements LlmClient {
  degraded = false;
  private readonly mock = new LlmMock();
  constructor(private readonly inner: LlmClient, private readonly timeoutMs = LIVE_LLM_TIMEOUT_MS) {}

  async complete(opts: { system?: string; prompt: string; json?: boolean }): Promise<string> {
    try {
      return await this.withTimeout(this.inner.complete(opts));
    } catch {
      this.degraded = true;
      return this.mock.complete(opts);
    }
  }

  private withTimeout(p: Promise<string>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('LLM timeout')), this.timeoutMs);
      p.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); },
      );
    });
  }
}

// A resolver hands each route a fully-built PipelineDeps with a FRESH config
// snapshot (so a PUT /api/config takes effect on the next request without a
// server restart) and guarantees store.init() has run exactly once.
type Resolver = () => Promise<PipelineDeps>;

// ---------------------------------------------------------------------------
// Route wiring — shared by the real app and test servers.
// ---------------------------------------------------------------------------
function buildApp(resolve: Resolver): Hono {
  const app = new Hono();

  app.use(
    '/api/*',
    cors({
      origin: ['http://localhost:5173'],
      allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  // ---- helpers ------------------------------------------------------------
  const readBody = async (c: any): Promise<any> => {
    try {
      const raw = await c.req.text();
      if (!raw) return {};
      return JSON.parse(raw);
    } catch {
      return null; // signals malformed JSON
    }
  };

  const findItem = async (
    store: MemoryStore,
    itemId: string,
  ): Promise<{ item: DonationItem; donation: Donation } | null> => {
    const donations = await store.listDonations();
    for (const d of donations) {
      const item = d.items.find((i) => i.id === itemId);
      if (item) return { item, donation: d };
    }
    return null;
  };

  // Rank every item of a donation, degrading per-item failures into warnings.
  const enrich = async (
    donation: Donation,
    deps: PipelineDeps,
  ): Promise<EnrichedDonation> => {
    const rankings: Record<string, RankedRecipient[]> = {};
    const warnings: string[] = [];
    for (const item of donation.items) {
      try {
        rankings[item.id] = await rankItem(item.id, undefined, deps);
      } catch (e) {
        rankings[item.id] = [];
        warnings.push(`ranking failed for item ${item.id}: ${errMsg(e)}`);
      }
    }
    const out: EnrichedDonation = { donation, rankings };
    if (warnings.length) out.warnings = warnings;
    return out;
  };

  // ---- health -------------------------------------------------------------
  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      mode: {
        llm: ENV.llmProvider,
        db: ENV.dbProvider,
        voice: ENV.voiceProvider,
      },
    }),
  );

  // ---- donations ----------------------------------------------------------
  app.post('/api/donations', async (c) => {
    const body = await readBody(c);
    if (body === null) return c.json({ error: 'invalid JSON body' }, 400);
    const { channel, contact, rawText } = body ?? {};
    if (typeof rawText !== 'string' || rawText.trim() === '') {
      return c.json({ error: 'rawText is required' }, 400);
    }
    try {
      const deps = await resolve();
      // §D.4 — use the configured provider, but cap it at 8s and degrade to the
      // mock on timeout/error so intake always resolves (surfaced via warnings).
      const guard =
        ENV.llmProvider === 'mock' ? undefined : new DegradingLlm(deps.llm);
      const ingestDeps = guard ? { ...deps, llm: guard } : deps;
      const donation = await ingestDonation(
        {
          channel: (channel ?? 'web_form') as Donation['sourceChannel'],
          contact: typeof contact === 'string' ? contact : '',
          rawText,
        },
        ingestDeps,
      );
      const enriched = await enrich(donation, deps);
      if (guard?.degraded) {
        enriched.warnings = [
          ...(enriched.warnings ?? []),
          `live LLM (${ENV.llmProvider}) timed out or failed; used the offline parser`,
        ];
      }
      return c.json(enriched);
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  app.get('/api/donations', async (c) => {
    try {
      const { store } = await resolve();
      return c.json(await store.listDonations());
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  app.get('/api/donations/:id', async (c) => {
    try {
      const deps = await resolve();
      const donation = await deps.store.getDonation(c.req.param('id'));
      if (!donation) return c.json({ error: 'donation not found' }, 404);
      return c.json(await enrich(donation, deps));
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  // ---- call log (§D.5) ----------------------------------------------------
  // Flattened, newest-first list of every call attempt across all donations,
  // derived from items' persisted attempts. Makes call logs first-class.
  app.get('/api/calls', async (c) => {
    try {
      const { store } = await resolve();
      const donations = await store.listDonations();
      const calls: CallLogEntry[] = [];
      for (const d of donations) {
        for (const item of d.items) {
          for (const attempt of item.attempts ?? []) {
            calls.push({
              donationId: d.id,
              itemId: item.id,
              itemName: item.item,
              ...attempt,
            });
          }
        }
      }
      calls.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)); // newest first
      return c.json(calls);
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  // NOTE (PRD §10 human-confirm gate): the autopilot/confirm gate is enforced
  // client-side only (DecisionPanel shows a confirm modal when autopilot is off).
  // This endpoint runs the full call loop unconditionally and is NOT an enforced
  // backend trust boundary — a direct API call bypasses the UI gate by design so
  // the offline canned-demo e2e and demo script can dispatch with an empty body.
  app.post('/api/donations/:id/dispatch', async (c) => {
    const id = c.req.param('id');
    try {
      const deps = await resolve();
      const existing = await deps.store.getDonation(id);
      if (!existing) return c.json({ error: 'donation not found' }, 404);
      const resolved = await dispatchDonation(id, deps);
      return c.json(resolved);
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  // ---- triage gate (PRD §10) ----------------------------------------------
  // The human decision point: an inbound donation sits at `awaiting_triage`
  // until a coordinator approves it here. Unlike /dispatch above, this returns
  // immediately (202) and runs the call loop in the background — a dispatch can
  // take minutes of real phone calls, and the dashboard has to watch it happen
  // rather than stare at one hanging request.
  app.post('/api/donations/:id/approve', async (c) => {
    const id = c.req.param('id');
    try {
      const deps = await resolve();
      const existing = await deps.store.getDonation(id);
      if (!existing) return c.json({ error: 'donation not found' }, 404);
      if (existing.status === 'dispatching') {
        return c.json({ error: 'already dispatching' }, 409);
      }
      if (existing.status === 'resolved') {
        return c.json({ error: 'already resolved' }, 409);
      }

      existing.status = 'dispatching';
      await deps.store.saveDonation(existing);

      // Fire-and-forget: the loop persists its own progress as each call lands,
      // so the UI follows along via GET /api/donations/:id. Errors are recorded
      // rather than thrown into a request nobody is holding open any more.
      void dispatchDonation(id, deps).catch(async (e) => {
        console.error('[dispatch] failed:', errMsg(e));
        const d = await deps.store.getDonation(id);
        if (d && d.status === 'dispatching') {
          d.status = 'resolved';
          d.donorMessage = `Dispatch failed: ${errMsg(e)}`;
          await deps.store.saveDonation(d);
        }
      });

      return c.json({ ok: true, status: 'dispatching', donationId: id }, 202);
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  // ---- directed / manual single-recipient calls (§G.3) --------------------
  // Map the pipeline's discriminated error to the right HTTP status.
  const directedStatus = (error: DirectedCallError): 404 | 409 =>
    error === 'item_not_pending' ? 409 : 404;
  const directedError: Record<DirectedCallError, string> = {
    item_not_found: 'item not found',
    recipient_not_found: 'recipient not found',
    item_not_pending: 'item is not pending',
  };

  // §G.3.1 — directed agent call to a chosen recipient, bypassing ranking.
  app.post('/api/items/:itemId/call/:recipientId', async (c) => {
    const itemId = c.req.param('itemId');
    const recipientId = c.req.param('recipientId');
    try {
      const deps = await resolve();
      const result = await directedCall(itemId, recipientId, deps);
      if (!result.ok) {
        return c.json({ error: directedError[result.error] }, directedStatus(result.error));
      }
      return c.json({ item: result.item, attempt: result.attempt });
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  // ---- live call feed (stage dashboard) -----------------------------------
  // Who is on the phone right now, and what is being said. Buffered in memory
  // and polled; empty between calls.
  app.get('/api/live', (c) => {
    return c.json({ calls: listLiveCalls() });
  });

  app.get('/api/live/:callId', (c) => {
    return c.json({ lines: getLiveTranscript(c.req.param('callId')) });
  });

  // §G.3.2 — human-logged manual call (recorded like an agent call, flagged manual).
  app.post('/api/items/:itemId/manual/:recipientId', async (c) => {
    const itemId = c.req.param('itemId');
    const recipientId = c.req.param('recipientId');
    const body = await readBody(c);
    if (body === null || typeof body !== 'object') {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const outcome = (body as { outcome?: unknown }).outcome;
    const validOutcomes: CallOutcome[] = ['accepted', 'declined', 'no_answer'];
    if (typeof outcome !== 'string' || !validOutcomes.includes(outcome as CallOutcome)) {
      return c.json({ error: 'outcome must be accepted, declined, or no_answer' }, 400);
    }
    const input: ManualCallInput = {
      outcome: outcome as CallOutcome,
      ...(typeof (body as { reason?: unknown }).reason === 'string'
        ? { reason: (body as { reason: string }).reason }
        : {}),
      ...(typeof (body as { notes?: unknown }).notes === 'string'
        ? { notes: (body as { notes: string }).notes }
        : {}),
    };
    try {
      const deps = await resolve();
      const result = await manualCall(itemId, recipientId, input, deps);
      if (!result.ok) {
        return c.json({ error: directedError[result.error] }, directedStatus(result.error));
      }
      return c.json({ item: result.item, attempt: result.attempt });
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  // ---- item re-rank (live slider preview; never persists weights) ---------
  app.post('/api/items/:id/rank', async (c) => {
    const id = c.req.param('id');
    const body = await readBody(c);
    if (body === null) return c.json({ error: 'invalid JSON body' }, 400);
    const weights: Weights | undefined =
      body && typeof body.weights === 'object' && body.weights !== null
        ? (body.weights as Weights)
        : undefined;
    try {
      const deps = await resolve();
      const found = await findItem(deps.store, id);
      if (!found) return c.json({ error: 'item not found' }, 404);
      const ranked = await rankItem(id, weights, deps);
      const warnings: string[] = [];
      let explanation = '';
      try {
        explanation = await explainRanking(found.item, ranked, deps.llm);
      } catch (e) {
        warnings.push(`explanation failed: ${errMsg(e)}`);
      }
      const out: { ranked: RankedRecipient[]; explanation: string; warnings?: string[] } =
        { ranked, explanation };
      if (warnings.length) out.warnings = warnings;
      return c.json(out);
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  // ---- recipients ---------------------------------------------------------
  app.get('/api/recipients', async (c) => {
    try {
      const { store } = await resolve();
      return c.json(await store.listRecipients());
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  app.get('/api/recipients/:id', async (c) => {
    const id = c.req.param('id');
    try {
      const { store } = await resolve();
      const recipient = await store.getRecipient(id);
      if (!recipient) return c.json({ error: 'recipient not found' }, 404);
      const history = await store.listHistory(id);
      return c.json({ recipient, history });
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  // ---- config -------------------------------------------------------------
  app.get('/api/config', async (c) => {
    try {
      const { store } = await resolve();
      return c.json(await store.getConfig());
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  app.put('/api/config', async (c) => {
    const body = await readBody(c);
    if (body === null || typeof body !== 'object') {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    try {
      const { store } = await resolve();
      const updated = await store.setConfig(body as Partial<AgentConfig>);
      return c.json(updated);
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  // ---- manager chat -------------------------------------------------------
  app.post('/api/manager/chat', async (c) => {
    const body = await readBody(c);
    if (body === null) return c.json({ error: 'invalid JSON body' }, 400);
    const message = body?.message;
    if (typeof message !== 'string' || message.trim() === '') {
      return c.json({ error: 'message is required' }, 400);
    }
    try {
      const { store, llm } = await resolve();
      const reply = await managerChat(message, store, llm);
      return c.json(reply);
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  // ---- equity simulation --------------------------------------------------
  app.get('/api/equity/simulate', async (c) => {
    const dropsRaw = c.req.query('drops');
    const parsed = dropsRaw !== undefined ? Number.parseInt(dropsRaw, 10) : NaN;
    const drops = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
    try {
      const { store } = await resolve();
      const recipients = await store.listRecipients();
      return c.json(simulateAB(recipients, drops));
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  // ---- demo controls ------------------------------------------------------
  app.post('/api/demo/reset', async (c) => {
    try {
      const { store } = await resolve();
      await store.reset();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  app.post('/api/demo/canned', async (c) => {
    try {
      const deps = await resolve();
      // §D.4 — stage insurance: the canned demo ALWAYS parses via the mock LLM
      // path regardless of LLM_PROVIDER, so it stays instant and offline.
      const cannedDeps = { ...deps, llm: new LlmMock() };
      const donation = await ingestDonation(
        {
          channel: CANNED_SCENARIO.channel,
          contact: CANNED_SCENARIO.contact,
          rawText: CANNED_SCENARIO.rawText,
        },
        cannedDeps,
      );
      return c.json(await enrich(donation, cannedDeps));
    } catch (e) {
      return c.json({ error: errMsg(e) }, 500);
    }
  });

  // ---- VAPI webhook sink (live mode only) ---------------------------------
  // This route is the far end of VapiVoice.placeCall: that call parks a promise
  // in vapi.ts's `pending` map keyed by callId, and only resolveCall() here can
  // complete it. Without this wiring every live call burns its 90s timeout and
  // reports no_answer no matter what the recipient said.
  app.post('/api/vapi/webhook', async (c) => {
    if (ENV.voiceProvider !== 'vapi') {
      return c.json({ ok: true, ignored: true });
    }

    // Shared secret, echoed by VAPI in X-Vapi-Secret (docs.vapi.ai, header is
    // case-insensitive per Hono). Enforced only when configured, so localhost
    // testing needs no secret — but a public tunnel without one lets anyone who
    // finds the URL forge an "accepted" outcome.
    if (ENV.vapiWebhookSecret) {
      if (c.req.header('x-vapi-secret') !== ENV.vapiWebhookSecret) {
        return c.json({ error: 'invalid or missing X-Vapi-Secret' }, 401);
      }
    }

    const body = await readBody(c);
    if (body === null) return c.json({ error: 'invalid JSON body' }, 400);

    const rawMsg = (((body as Record<string, unknown>).message ?? body) ?? {}) as Record<string, unknown>;
    const msgType = String(rawMsg.type ?? '');
    const call = (rawMsg.call ?? {}) as Record<string, unknown>;

    // A donor is calling us. VAPI asks which assistant should answer and gives
    // us 7.5s to reply, so this path stays static config — no store, no model.
    if (msgType === 'assistant-request') {
      return c.json({ assistant: buildInboundAssistant() });
    }

    // Live captions: partial transcripts stream in while a call is in progress.
    // Recorded against the call id so the dashboard can poll them mid-call.
    if (msgType === 'transcript') {
      const callId = String(call.id ?? '');
      const role = String(rawMsg.role ?? '');
      const text = String(rawMsg.transcript ?? '');
      if (callId && text) {
        appendLiveTranscript(callId, {
          speaker: role === 'assistant' || role === 'bot' ? 'agent' : 'recipient',
          text,
        });
      }
      return c.json({ ok: true });
    }

    let normalized;
    try {
      normalized = parseWebhook(body);
    } catch (e) {
      // parseWebhook throws on any message type we don't act on. VAPI treats
      // 4xx as "rejected" (no retry), so a 400 wouldn't cause a retry storm —
      // but these are messages we deliberately ignore, not client errors, and
      // 200 keeps them out of VAPI's webhook error dashboard.
      return c.json({ ok: true, ignored: true, reason: errMsg(e) });
    }

    // false ⇒ no pending call for this id: server restarted mid-call, a
    // duplicate delivery, or a call placed by another process. Nothing a retry
    // could fix, so acknowledge rather than 5xx.
    const matched = resolveCall(normalized);
    if (matched) {
      clearLiveTranscript(normalized.callId);
      return c.json({ ok: true, matched, callId: normalized.callId });
    }

    // Not one of our outbound calls — a donor called US. Parse what they said
    // into a donation and park it for human triage (never auto-dispatch: the
    // whole point of the gate is that a person decides).
    if (isInboundCall(call)) {
      try {
        const transcript = String(
          ((rawMsg.artifact ?? {}) as Record<string, unknown>).transcript ?? '',
        );
        const rawText = transcriptToRawText(transcript);
        if (!rawText) {
          return c.json({ ok: true, ignored: true, reason: 'inbound call had no transcript' });
        }
        const deps = await resolve();
        const donation = await ingestDonation(
          {
            channel: 'voice',
            contact: String((call.customer as Record<string, unknown>)?.number ?? 'unknown'),
            rawText,
          },
          deps,
        );
        donation.status = 'awaiting_triage';
        await deps.store.saveDonation(donation);
        clearLiveTranscript(normalized.callId);
        return c.json({ ok: true, inbound: true, donationId: donation.id, items: donation.items.length });
      } catch (e) {
        return c.json({ ok: true, inbound: true, error: errMsg(e) });
      }
    }

    return c.json({ ok: true, matched, callId: normalized.callId });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Test-friendly factory: inject stubbed singletons.
// ---------------------------------------------------------------------------
export function createServer(deps: ServerDeps): Hono {
  let initP: Promise<void> | undefined;
  const resolve: Resolver = async () => {
    if (!initP) initP = Promise.resolve(deps.store.init());
    await initP;
    return { ...deps, config: await deps.store.getConfig() };
  };
  return buildApp(resolve);
}

// ---------------------------------------------------------------------------
// Default app: real singletons built lazily from factories, init() once.
// ---------------------------------------------------------------------------
let singletons: ServerDeps | undefined;
let realInitP: Promise<void> | undefined;

function realResolve(): Promise<PipelineDeps> {
  if (!singletons) {
    singletons = { store: createStore(), llm: createLlm(), voice: createVoice() };
  }
  const s = singletons;
  if (!realInitP) realInitP = Promise.resolve(s.store.init());
  return realInitP.then(async () => ({
    ...s,
    config: await s.store.getConfig(),
  }));
}

export const app = buildApp(realResolve);

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // Construct singletons + store.init() BEFORE serving (contract §9).
  realResolve()
    .then(() => {
      serve({ fetch: app.fetch, port: ENV.port }, (info) => {
        // eslint-disable-next-line no-console
        console.log(`Donna backend listening on http://localhost:${info.port}`);
      });
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error('Failed to start Donna backend:', errMsg(e));
      process.exit(1);
    });
}
