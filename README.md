# Donna

**An autonomous dispatcher for food-bank donations.**

Food comes in through any channel → an AI agent structures it → a transparent
scoring engine matches each item to the fairest capable recipient using
persistent memory → voice agents make the calls → the donor always hears back →
the manager tunes it all by chatting.

Built for the AI Supply Chain Hackathon.

## The idea in one line
**AI at the edges, deterministic fairness math in the middle** — so allocation is
fast *and* explainable *and* provably equitable over time.

## Stack
- **VAPI + Twilio** — real-time voice (inbound donor intake + outbound offers)
- **Gemini 2.5 Flash** — agent brains (intake parsing, offers, manager chat,
  donor callback) *and* the model that talks on the phone. Transcription is
  Deepgram, VAPI's default
- **Deterministic scoring engine** — the auditable core that picks recipients.
  No LLM touches the allocation decision
- **JSON store** behind a pluggable `MemoryStore` interface — a food bank points
  it at their own database by implementing one class
- *(InsForge code paths exist but are inert — see PRD §11 for why)*

## The agents
1. **Intake Parser** — any channel → structured, multi-item donation
2. **Offer Drafter** — writes the pitch / call script
3. **Recipient Caller** — voice-calls pantries *and* community-agency leads
4. **Manager Copilot** — manager tunes the system by chatting
5. **Donor Callback** — itemized "here's what we could and couldn't take"

Plus a deterministic **Scoring Engine** (feasibility · cold-chain · capacity ·
equity · preferences) and **persistent recipient memory** that learns from every
call.

## Run it

**Everything runs in mock mode by default — zero API keys, zero network calls.**
The full canned demo scenario works entirely offline.

### One command

```bash
./scripts/demo.sh
```

This installs deps if needed, boots the backend (`:8787`) and the Vite frontend
(`:5173`), waits for the backend health check, and opens the browser. Press
`Ctrl-C` to stop both. In the UI, click **▶ Canned demo** to run the scenario:
strawberries land at a walk-in-fridge pantry, canned beans go to a small agency,
day-old bread finds no home (partial placement), and the donor gets an itemized
callback.

### Manual (two terminals)

```bash
# terminal 1 — backend (Hono API on :8787)
cd backend && npm install && npm run dev

# terminal 2 — frontend (Vite dev server on :5173, proxies /api → :8787)
cd frontend && npm install && npm run dev
```

Open <http://localhost:5173>.

### Verify without the UI

```bash
cd backend && npm test          # 119 unit/integration tests, all mock-mode
npm run build                   # backend tsc → dist/
cd ../frontend && npm run build # tsc + vite build
```

Quick end-to-end smoke via the API:

```bash
curl -s localhost:8787/api/health
curl -s -XPOST localhost:8787/api/demo/canned            # parse 3 items
curl -s -XPOST localhost:8787/api/donations/<id>/dispatch # run call loop + callback
curl -s "localhost:8787/api/equity/simulate?drops=30"    # donna gini < nearest gini
```

### Live mode (optional — flip env vars)

Mock adapters sit behind interfaces; live mode is a pure env-var flip. Copy
`backend/.env.example` to `backend/.env` and set only what you need:

| Capability | Env flip | Extra vars |
|---|---|---|
| **LLM** (real agents) | `LLM_PROVIDER=anthropic` | `ANTHROPIC_API_KEY` |
| | `LLM_PROVIDER=insforge` | `INSFORGE_AI_BASE_URL`, `INSFORGE_AI_KEY`, `INSFORGE_AI_MODEL` |
| **Database** (persistent) | `DB_PROVIDER=insforge` | `INSFORGE_BASE_URL`, `INSFORGE_API_KEY` |
| **Voice** (real calls) | `VOICE_PROVIDER=vapi` | `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID` |

Any unset provider stays on its mock/sim implementation, so you can flip one axis
at a time. Full live-mode runbook (InsForge project, schema, edge functions, VAPI
webhook wiring): [docs/INSFORGE_SETUP.md](docs/INSFORGE_SETUP.md).

## → Full spec: [PRD.md](PRD.md)
