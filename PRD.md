# Donna — Product Requirements Document

> **Donna** is an autonomous dispatcher for food-bank donations. Food comes in
> through any channel, AI agents structure it, a transparent scoring engine
> matches each item to the fairest capable recipient using persistent memory,
> voice agents make the calls, and every donor hears back — always.

- **Status:** v1 spec (hackathon build — 1 day)
- **Last updated:** 2026-07-16
- **Owner:** Sharique Khatri

---

## 1. The Problem

Food banks don't receive predictable, uniform shipments. They receive **erratic,
perishable donations** — a truck pulls up with five pallets of rejected
strawberries that spoil in 48 hours. Someone has to decide, right now, who gets
them.

Two bad defaults dominate today:

- **Call pantries one by one** → the food spoils before a match is found.
- **Always give it to the closest pantry** → distribution becomes structurally
  unfair; farther or slower recipients are silently starved over time.

The real problem is **just-in-time, multi-objective allocation under a spoilage
clock**, wrapped in a messy human front end (phone calls, texts, walk-ins) and a
trust requirement (a coordinator won't hand allocation to a black box).

### Who feels it
- **Food-bank coordinators** — drowning in phone tag while food spoils.
- **Donors** (drivers, retailers, individuals) — no closure; food is offered
  into a void.
- **Recipients** (pantries + community agencies) — unequal access to supply.

---

## 2. The Solution — in one breath

Food comes in through any channel → an agent structures it → fair math picks the
best recipient using what we remember about them → an agent calls them by voice →
the answer teaches the system → the donor always hears back → the manager tunes
it all by chatting.

### The core architectural insight
**AI at the edges, deterministic math in the middle.**

- LLM agents handle the messy, human-language edges: parsing intake, drafting
  offers, holding voice conversations, chatting with the manager.
- The **allocation decision itself is plain, auditable math** — not an LLM guess.
  This is deliberate: it's fast, reproducible, and *defensible* to a coordinator
  who needs to trust and override it.

---

## 3. System Flow

```
   Voice call / voicemail ─┐
   SMS / text ─────────────┤
   Email ──────────────────┼─▶ Intake Normalizer ─▶ raw text ─▶ Agent 1 (parse)
   Walk-in (staff entry) ──┤     (channel adapters)                   │
   Web form ───────────────┘                              structured donation
                                                          (1 donation → N items)
                                                                     │
                                                                     ▼
                              ┌──────────── Database ◀───────────────┤
                              │                                       │
                    Persistent Recipient Memory ─────▶  SCORING ENGINE  (per item)
                    (infra · prefs · capacity ·         deterministic, multi-objective
                     history · fair-share)                            │
                              ▲                                       ▼
                              │                              ranked recipients
                              │                                       │
                              │                            Agent 2 (draft offer)
                              │                                       │
                              │                            Agent 3 (VAPI outbound call)
                              │                             calls pantry OR agency lead
                              │                                       │
                              │                        ┌──────────────┴──────────────┐
                              │                     accepted                       declined
                              │                        │                     (reason → memory,
                              │                        │                      re-rank next best)
                              │                        ▼                              │
                              └──── outcome logged ────┴──────────────────────────────┘
                                                                     │
                                              (per-item results aggregated per donation)
                                                                     ▼
                                                    Agent 5 (Donor Callback)
                                          itemized result back to source, same channel:
                                          "We can take X and Y; can't place Z in time."

   Agent 4 (Manager Copilot) ⇄ Recipient Memory   — manager chats; edits config the agents read
   Food-bank Inventory feed  ─▶ Recipient Memory   — connected live context
```

---

## 4. The Agents

Five LLM agents at the edges + one deterministic engine at the core.

| # | Agent | Trigger | In → Out | Runtime |
|---|-------|---------|----------|---------|
| **0** | **Intake Receptionist** | A donor phones in | greets, asks what/how much/how soon, pickup + name → call transcript | VAPI in-call (Gemini 2.5 Flash) |
| **1** | **Intake Parser** | Transcript or text arrives | raw text → structured donation with N line-items `{item, qty, unit, hours_to_spoil, needs_refrigeration, category}` | Gemini 2.5 Flash |
| **2** | **Offer Drafter** | After scoring | item + top recipient → offer pitch (used as the call script / text body) | Gemini 2.5 Flash |
| **3** | **Recipient Caller** | Offer ready, human approved | VAPI voice call to pantry **or** community-agency lead → accept / decline + reason | VAPI in-call (Gemini 2.5 Flash) |
| **4** | **Manager Copilot** | Manager chats | NL instruction → structured edits to recipient memory / agent config | Gemini 2.5 Flash |
| **5** | **Donor Callback** | All items resolved | per-item outcome → message back to donor on original channel | Gemini 2.5 Flash |
| — | **Scoring Engine** | Donation stored | item + all recipients + memory → ranked list w/ score breakdown | **Deterministic (code, not AI)** |

*Agent 0 is new: inbound telephony was out of scope in v1 (§15) and is now built.
It is also the first path where Agent 1 does real work — the canned demo
hardcodes the mock parser.*

### Live voice vs. back-office thinking
- **In-call intelligence** (talking to a driver or a pantry in real time) runs on
  **VAPI's infrastructure** — sub-second streaming ASR→LLM→TTS. This is not a CLI
  or back-office job. The LLM in that loop is Gemini 2.5 Flash; the ASR is
  Deepgram (VAPI's default).
- **Everything after/around a call** (parse, score-explain, draft, manager chat,
  callback composition) is not latency-critical and runs on **Gemini 2.5 Flash**
  via Google's OpenAI-compatible endpoint.
- **Known limit:** an in-call model asked something it was never told will invent
  an answer — observed live, it fabricated both a food-bank name and a donation's
  provenance. Prompts now name the operator explicitly and forbid invention, but
  the outbound assistant still is not given the donation's real source, so it
  cannot answer "where is this from?" truthfully. Sourcing is a food-safety fact;
  this is a real gap, not a cosmetic one.

---

## 5. The Scoring Engine (the IP)

Runs **per line-item**. Deterministic, transparent, tunable. Every recipient
gets a score with a visible breakdown.

```
score(item, recipient) =
      w_feasibility · feasibility     # HARD GATE: can they receive before spoilage? else 0
    + w_coldchain   · coldchain_fit   # has refrigeration if item needs it? else heavy penalty
    + w_capacity    · capacity_fit    # peaks when item qty ≈ recipient throughput; penalize under & over
    + w_equity      · equity_boost    # + k · (network_avg_received − this_recipient_received)
    + w_prefs       · category_match  # from memory: do they want this category? did they reject it before?
```

- **Feasibility** — `drive_time` vs `hours_to_spoil`. If they can't receive it in
  time, the item is infeasible for them (score 0). This is the cold-chain
  constraint made real.
- **Cold-chain fit** — needs_refrigeration AND has_capacity? Gate/penalty.
- **Capacity fit** — penalize both under-allocation (waste at a tiny recipient)
  and over-allocation (more than they can move).
- **Equity boost** — lifts recipients below their fair share of recent supply.
  This is the term that makes distribution provably fair over time.
- **Category / preference match** — read from persistent memory: preferred
  categories, prior rejections, infrastructure.

**Weights (`w_*`) are live, manager-tunable sliders.** Policy is an explicit
human choice, not a hidden model behavior.

**Equity ledger:** cumulative allocation per recipient over time, with a fairness
metric (e.g. min/max ratio or Gini). The demo shows **"nearest-recipient" vs.
Donna** over a run of simulated drops — proving the closest-first default creates
inequality and Donna corrects it. This is the defensible differentiator.

---

## 6. Data Model

*Storage-agnostic: this is the shape behind the `MemoryStore` interface, not a
vendor's schema. The JSON store implements it today; a food bank's own Postgres
implements the same 14 methods.*

```
donation
  id · source_channel · source_contact · received_at · raw_text · status

donation_item          (1 donation → N items)
  id · donation_id · item · qty · unit · category
  hours_to_spoil · needs_refrigeration
  status: pending | matched | declined | unplaceable
  matched_recipient_id · resolution_reason

recipient
  id · name · type: pantry | community_agency · lead_contact · phone
  location (lat/lng)
  infrastructure: [walk-in_fridge, dry_storage, ...]
  accepts: [categories] · rejects: [categories]
  typical_volume · best_call_window
  received_ytd            # fuels the equity term

recipient_history
  id · recipient_id · item_id · outcome · reason · at

agent_config
  weights {feasibility, coldchain, capacity, equity, prefs}
  autopilot: bool         # auto-call vs human-confirm gate
  per-agent skill toggles (manager-editable via Agent 4)
```

---

## 7. Multi-Channel Intake

Channel is just a front door. Every channel normalizes to
`{source_channel, raw_text, contact}`, then the pipeline is identical.

| Channel | Adapter | v1 |
|---|---|---|
| Voice call / voicemail | VAPI transcript | **Build first (flashiest)** |
| SMS / text | message body | Stretch |
| Email | body text (Gmail pull optional) | Stretch |
| Walk-in / phone-taken-by-staff | coordinator text box | **Build (trivial, great for demo)** |
| Web form | already structured (skip parse) | Optional |

Donation carries a `source_channel` field so the UI shows *how* each donation
arrived — and the demo can ingest the same donation multiple ways into one brain.

---

## 8. Closed Loop & Donor Callback

- **Items are first-class.** One donation → many line-items, each matched
  independently. A donation can end partially placed.
- Agent 3 places recipient calls for items that matched.
- When all items resolve, **Agent 5 calls/texts/emails the donor back on their
  original channel** with the itemized result:
  > *"Thanks — we can take the strawberries and the beans. We can't place the
  > bread before it spoils. Want to try another drop-off for that?"*
- If **nothing** matches: a polite "sorry, we can't accept these right now."
- **The donor always hears back.** Nothing silently spoils.

---

## 9. Persistent Memory & Learning

- Every call outcome writes to `recipient_history` and updates the recipient
  profile (e.g. decline reason *"overstocked on produce"* lowers that category's
  match for a window).
- The scoring engine and **all** voice agents read memory — so Agent 3 can open a
  call with context: *"I've got fresh strawberries — I know you've got walk-in
  fridge space and took produce last week…"*
- **Manager Copilot (Agent 4)** edits memory/config declaratively via chat:
  *"St. Mary's got a new freezer"* → sets `infrastructure += walk-in_fridge`;
  *"stop sending Oak Ave anything but canned goods"* → sets `accepts = [canned]`.
  The manager tunes behavior by **talking**, not coding. (Declarative edits only —
  no free-form prompt rewriting, for predictability.)

---

## 10. Trust & Safety

- **Human-confirm gate** before any outbound call fires, with an
  **autopilot ⇄ confirm** toggle. Shows the system respects coordinator control.
- Scoring is deterministic and **fully explained** (Agent-generated "why #1 beat
  #2" rationale over the numeric breakdown).
- Manager can override any allocation in one click.

---

## 11. Tech Stack

*Updated 2026-07-16 to match what actually runs. The original plan below the
table is kept because the reasons it changed are worth knowing.*

| Layer | Choice | Why |
|---|---|---|
| Voice (in/out) | **VAPI**, telephony via **Twilio** | Bundled streaming ASR→LLM→TTS; owns real-time calls. Inbound: the number routes to our server, which answers VAPI's `assistant-request` with a transient assistant, so Donna's persona lives in code |
| In-call model | **Gemini 2.5 Flash** (`provider: google`) | The model that actually talks on the phone. `flash` because a call is latency-critical |
| Transcription | **Deepgram** (VAPI default) | Speech→text only. Streaming ASR is its own job; Google STT is available but Deepgram is the recommended default and transcription quality gates everything downstream |
| Agent brains (1, 2, 4, 5) | **Gemini 2.5 Flash** via Google's OpenAI-compatible endpoint | Intake parsing, offer drafting, manager chat, donor callback. Not latency-critical |
| Scoring engine | Deterministic TypeScript | Auditable, instant, reproducible. **No LLM touches the allocation decision** |
| Database | JSON store behind a pluggable `MemoryStore` interface | 14 methods; `DB_PROVIDER` selects the implementation. A food bank brings its own Postgres/Airtable by writing one class |
| Frontend | Stage dashboard + map console (Leaflet) + Manager chat | Live call transcripts, ranked recipients, breakdowns, equity ledger, weight sliders |

**What changed from the original plan, and why:**

- **InsForge is not used.** It was to be the DB, the agent brains, and the
  serverless host. All three fell through: the AI gateway at `/api/ai/v1` returns
  404 (the route does not exist), the schema was never applied, and the
  serverless host is architecturally incompatible — `placeCall` parks a promise
  in memory that a webhook must resolve, and on serverless the webhook is a
  different invocation with a different memory space. The `insforge` code paths
  remain but are inert.
- **Gemini replaced InsForge AI** — one env var, because every agent talks to an
  OpenAI-compatible endpoint through a single `LlmClient` interface.
- **The backend is a long-lived Node process, not serverless.** This is the
  honest tradeoff for the pending-promise call design. Making the whole brain
  serverless means rebuilding the call flow as a webhook-driven DB state machine
  with no awaited promises — the right architecture, and still true to the pitch
  below, but not a one-day change.

**Why the architecture still travels:** the intelligence is all hosted APIs and
the store is one interface away from any database — a food bank onboards by
pointing config at their own data, not by installing a stack.

---

## 12. One-Day Build Scope — Real vs. Simulated

Build the **intelligence for real**; simulate the **expensive plumbing** so the
demo is fully believable without burning the day on telephony.

| Piece | v1 (win-in-a-day) |
|---|---|
| Agent 1 Intake | **Real** — fed a transcript/text (paste or pre-recorded voicemail) |
| Scoring engine + memory | **Real — the star.** Defensible IP |
| Agent 2 Offer | **Real** |
| Agent 3 Recipient call | **Real** — live VAPI outbound calls, verified end to end. `VOICE_PROVIDER=sim` keeps the deterministic simulator as the offline fallback |
| Agent 4 Manager Copilot | **Real** — chat that edits memory live (cheap, huge wow) |
| Agent 5 Donor Callback | **Real logic**, delivered as text/on-screen by default; voice if time |
| Multi-channel intake | **Real inbound phone call** + walk-in text box built; SMS/email stretch |
| Equity ledger + A/B chart | **Real** — nearest-recipient vs. Donna over 30 simulated drops |

**Non-negotiables for demo day:**
1. A **canned/cached demo path** (the strawberry scenario) so no live call/AI
   latency can stall the pitch.
2. The **A/B equity chart** — quantified fairness beats a vibe.

### Suggested hour-by-hour
| Time | Build |
|---|---|
| 0–1h | Project + store; seed ~15 recipients (pantries + agencies) |
| 1–3h | Scoring engine + `/score` (per item). Unit-test the equity term |
| 3–4h | Agent 1 intake (text → structured items) |
| 4–6h | Map console: donation + ranked recipients + breakdown cards |
| 6–7h | Live weight sliders → re-score on drag |
| 7–8h | Agent 2 offer + Agent 3 call (simulated) + decline → re-rank |
| 8–9h | Agent 5 donor callback (itemized) + Agent 4 manager chat |
| 9–10h | Equity ledger + A/B chart; seed canned demo scenario |
| +buffer | One real VAPI outbound call if ahead of schedule |

---

## 13. Demo Script (the 2-minute pitch)

1. *"A truck of strawberries + beans + bread just got rejected — 48 hours to
   spoil."* Paste the driver's voicemail transcript.
2. Agent 1 structures it into 3 items on screen.
3. Map lights up; each item ranks recipients with visible reasons. Bread finds
   no feasible home.
4. Drag the **equity** slider up — the winner reshuffles live.
5. Agent 3 "calls" the top pantry → accepts strawberries. Community agency takes
   the beans.
6. Agent 5 texts the donor back: *"Got the strawberries and beans; couldn't place
   the bread in time."*
7. Manager chats: *"St. Mary's got a new freezer"* → memory updates, ranking
   shifts.
8. **Closer:** the equity ledger — nearest-recipient vs. Donna over 30 drops.
   *"The closest-pantry default creates inequality. Donna proves it's fair."*

---

## 14. Success Criteria

- **Works end-to-end** on the canned scenario without a human touching a
  terminal.
- **Multi-item, partial-placement** handled and shown.
- **Donor always hears back**, itemized.
- **Equity is quantified**, not asserted (A/B chart).
- **Manager changes behavior by chatting**, live, on stage.
- The allocation decision is **explainable** — every rank has a reason.

---

## 15. Out of Scope (v1)

*Updated 2026-07-16.*

- ~~Real inbound telephony ingestion (use transcripts).~~ **Now built** — a donor
  calls a real Twilio number, Donna answers, and the transcript becomes a
  donation held for human triage.
- Full SMS + email adapters (stretch).
- Route optimization / driver dispatch logistics.
- Auth, multi-tenant, production hardening.
- Free-form manager prompt editing (declarative config only).
