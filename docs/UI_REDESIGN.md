# Donna — UI Redesign + Live-Key Wiring (v1.1)

> Binding contract for the v1.1 fix pass. Supersedes ARCHITECTURE §13 for the
> frontend. Everything else in ARCHITECTURE.md still holds unless amended in §D.

## A. Why (user feedback, verbatim priorities)

1. **"Way too much text / no one wants so much bs on their screen."** The console
   must become minimal. The MAP is good — make it the hero; everything else gets
   out of its way.
2. **"All this information must be stored in the DB, come from the DB, go to the DB."**
   The UI must be DB-first: it *renders* server state, never owns it. Intake is
   not a giant always-on form — donations *arrive* (via channels → DB) and appear
   in a feed. When VAPI inbound goes live, calls land in the DB via webhook and
   appear in the same feed with ZERO frontend changes.
3. **"Call logs must go directly to the DB."** Attempts/transcripts are already
   persisted on items; the UI must read them from fetches only, and a dedicated
   call-log endpoint makes them first-class.
4. **The offer script is a data dump.** It recites the recipient's DB row
   (Infrastructure: …, Prefers: …, Does not take: …). Forbidden. Scripts become
   short and human.

## B. Design language (hard rules)

- **Map full-bleed hero.** It renders edge-to-edge under everything; panels float
  over it as compact overlays with translucent dark surfaces (backdrop-blur ok).
- **One accent color** (keep the orange) for actions/pickup. Status is dots only:
  green=matched/accepted, red=declined/unplaceable, grey=pending/infeasible.
  KILL the 5-color stacked bars from the default view (breakdown lives behind an
  expand interaction).
- **Text budget:** any visible entity gets ≤2 lines by default. No ALL-CAPS
  section shouting ("INTAKE", "DECISION" headers: gone). No raw enum tokens in
  UI copy (`fresh_produce` → "fresh produce", `walk_in_fridge` → "walk-in fridge")
  — add a `humanize()` util and use it EVERYWHERE user-visible.
- Header shrinks to 44px: wordmark · Dispatch|Equity segmented control · a single
  status dot w/ tooltip (mode) · reset icon-button. No text chips.

## C. Layout spec

```
┌────────────────────────────────────────────────────────────┐
│ Donna        [Dispatch|Equity]                    ● ↻      │ 44px
├──────────┬────────────────────────────────┬────────────────┤
│ Feed     │                                │ (only when an  │
│ 300px    │        FULL-BLEED MAP          │ item selected) │
│ overlay  │  pickup pin + scored pins      │ Detail 340px   │
│          │                                │ overlay        │
│ [+ New]  │                                │                │
└──────────┴────────────────────────────────┴────────────────┘
```

**Left — Live feed (300px floating panel):**
- Title: "Live feed" + subtle channel legend. Content = `GET /api/donations`
  polled every 3s (silent refetch; no spinners after first load).
- Donation card (≤2 lines): `donor · channel icon · time` / item pills
  (status-dot + short name only). Click item pill → select item (map + detail).
- Bottom: one primary button **“+ Donation”** → opens a **modal** containing what
  used to be the intake panel: channel tabs, textarea, Parse & score, and a small
  "Play canned demo" text-button. The modal is the ONLY place intake UI exists.
- Empty state: one quiet line ("Waiting for donations…").

**Right — Detail overlay (340px, mounts only on selection, closable ✕):**
1. **Item strip:** `fresh strawberries · 5,000 lb · ❄ · spoils in 48h` +
   status dot. One line.
2. **Ranked matches (compact):** each row = `#n  Name  ······  0.80` with a thin
   single-color score bar underneath. Max 5 rows visible; hard-fails collapsed
   under one muted row: "7 not feasible ▸". Clicking a row expands IN PLACE:
   five labeled micro-bars (term breakdown), drive time, one "why" sentence
   (from `/api/items/:id/rank` explanation). Only one row expanded at a time.
3. **Tune (hidden by default):** a small `⚙` icon-button reveals the 5 weight
   sliders inline (debounced live re-rank, as today). Collapsed on mount.
4. **Dispatch** — the one primary button (confirm modal when autopilot off).
5. **Activity (after dispatch):** ONE LINE per attempt:
   `✗ Richmond District Larder — still overstocked on baked` /
   `✓ Chinatown Community Pantry — accepted`. Click a line → expands the full
   transcript (chat bubbles, as today but 13px). Donor callback = one compact
   SMS-style bubble "To Marcus:" at the end, collapsed to 2 lines + "more".
- Everything in this panel renders exclusively from fetched DB state; after any
  action → refetch donation; NO domain data held in component state.

**Equity view:** unchanged charts, tightened: stat tiles row (nearest vs donna
gini + min/max), then the two charts. Remove any explanatory paragraphs — one
caption line each.

## D. Backend amendments (ARCHITECTURE stays authoritative + these)

1. **Gemini LLM provider.** `createLlm()` gains `'gemini'`: reuse
   `llmOpenAICompat.ts` pointed at Google's OpenAI-compatible endpoint
   `https://generativelanguage.googleapis.com/v1beta/openai` with
   `GEMINI_API_KEY`, model `GEMINI_MODEL` (default `gemini-2.5-flash`).
   Update config.ts env matrix + `.env.example` (LLM_PROVIDER adds `gemini`;
   GEMINI_API_KEY, GEMINI_MODEL). Update ARCHITECTURE §6/§10 accordingly.
2. **.env loading.** config.ts loads `backend/.env` at boot via
   `process.loadEnvFile` (Node ≥20.12) inside try/catch (absent file = fine).
   No new dependency. Real env vars win over file values.
3. **Offer scripts become human** (mock template AND live prompt): ≤2 sentences,
   spoken register. Structure: greeting w/ contact first name → what + how much
   + spoilage urgency → AT MOST ONE contextual clause drawn from memory (e.g.
   "I know you've got walk-in fridge space") → the ask. NEVER enumerate
   infrastructure/accepts/rejects lists; never print raw enum tokens. Same rule
   for donor-callback copy (already close; verify).
4. **Canned demo stays instant:** `/api/demo/canned` ALWAYS uses the mock LLM
   path regardless of LLM_PROVIDER (it is the stage-insurance path). Normal
   `POST /api/donations` uses the configured provider with graceful degrade to
   mock on error/timeout (8s cap) + `warnings[]` as today.
5. **Call log endpoint:** `GET /api/calls` → flattened, newest-first
   `[{donationId, itemId, itemName, ...CallAttempt}]` from the DB (derived from
   items' attempts). The UI may use it later; it makes call logs first-class.
6. **VAPI key validation (no calls placed!):** a small
   `backend/scripts/vapi-check.ts` (run: `npx tsx scripts/vapi-check.ts`) that
   GETs `https://api.vapi.ai/phone-number` with VAPI_API_KEY, prints status +
   any phone-number ids. Integrator runs it once and reports; if exactly one
   number exists, write its id into `.env` VAPI_PHONE_NUMBER_ID. Placing real
   calls remains out of scope for this pass.
7. **Live-Gemini smoke:** with the provided key, POST a fresh non-canned
   donation text through `POST /api/donations` under `LLM_PROVIDER=gemini` and
   assert ≥1 item parses sanely (network test, integrator-only, not vitest).

## E. Non-negotiables / guardrails

- `.env` is NEVER committed (already gitignored) and keys NEVER appear in
  frontend code or in any committed file. tests stay green with zero env vars
  (mock default when .env absent).
- Map behavior, scoring engine, pipeline, and API contract (beyond §D additions)
  DO NOT CHANGE in this pass.
- All 120 existing tests keep passing (offer-template tests may be UPDATED to
  assert the new humane script shape — that's a legitimate spec change, not
  test-gaming; same for any snapshot-ish string assertions).
- `tsc` + `vitest` + `vite build` green; canned e2e still <1s.

## F. v1.2 — Inbound / Outbound split (user feedback)

The two docks become directional. "Left shows inbound, right shows outbound."

**Left dock (300px) — retitle "Inbound".** Content as today: DB-polled donation
feed + "+ Donation" modal button. No other changes.

**Right dock (340px) — new default view "Outbound".** Always mounted (no longer
only-on-selection). A DB-first feed of everything Donna sends OUT, newest first:
- **Call attempts** from `GET /api/calls` (polled every 3s, silent): one row per
  attempt — status dot (green accepted / red declined / grey no-answer),
  recipient name, item name, time. Click row → expand transcript inline
  (one-at-a-time, as the detail activity list today).
- **Donor callbacks** interleaved: derived client-side from resolved donations
  with a `donorMessage` (timestamp = latest attempt `at` on that donation, else
  `receivedAt`). Row: ✉ "To {donorName}" + first line; click → full message.
- Empty state: one quiet line ("No outbound activity yet.").

**Item detail becomes a swap, not a separate panel.** Clicking an item pill in
Inbound swaps the right dock's content to the item Detail view (item strip,
ranked rows, ⚙ tune, Dispatch, per-item activity — unchanged from §C). A
"← Outbound" back control (and ✕) returns to the Outbound feed. After a
dispatch, returning to Outbound shows the fresh attempts via the poll.

Frontend-only change (plus `getCalls()` + `CallLogEntry` in the typed api
client). §B design rules (one accent, ≤2-line rows, humanized copy) apply
unchanged. tsc + vite build must stay green.

## G. v1.3 — Procurement board (user feedback)

Mental model shift: Inbound = ITEMS being procured and their fate. Outbound =
the RECIPIENT NETWORK (places whose phone numbers are on file). Feeds are out;
state is in. Plus: the dashboard needs a real visual-quality pass.

### G.1 Left dock — "Inbound"
Item-centric cards (from the DB donations poll, flattened to items, newest
donation first), each ≤2 lines:
- Line 1: item name · qty lbs · spoil countdown (`❄` if refrigerated)
- Line 2: donor · channel icon · time
- Status treatment (must be UNMISSABLE at a glance, e.g. colored left edge +
  dot): **amber** pending → **green** placed (line 2 gains "→ {recipient}") →
  **RED** unplaceable — the item "will not be procured"; red card tint, line 2
  gains "no takers — donor notified".
- Click an item card → right dock swaps to the existing item Detail view
  (rankings / tune / Dispatch); "← Network" back control returns.
- "+ Donation" button stays. Donation-level grouping may appear only as a thin
  separator label (donor · time), never a heavy card-in-card.

### G.2 Right dock — "Outbound · Network"
Directory of ALL recipients from `GET /api/recipients` (these ARE the places
with phone numbers on the dashboard). Sort: most-recently-called first, then
alphabetical. Row (≤2 lines collapsed):
- Line 1: name · type glyph · status dot of their LAST call (green accepted /
  red declined / grey never-called)
- Line 2: chips of item names this place has AGREED TO TAKE (from accepted
  attempts in the DB, across all donations); if none: muted phone number.
- Click row → expand in place (one at a time):
  - lead contact · phone · drive-relevant info kept minimal
  - Call history from the DB: one line per call (item · time · outcome);
    click a line → full transcript chat bubbles (as today).
  - Two actions:
    **"Donna, call"** → modal: pick any PENDING item → `POST
    /api/items/:itemId/call/:recipientId` → directed agent call (sim/vapi per
    env) → transcript appears in place, statuses update everywhere.
    **"Log manual call"** (human intervention) → modal: pick pending item,
    outcome accepted/declined, optional reason/notes → `POST
    /api/items/:itemId/manual/:recipientId` → recorded in the DB exactly like
    an agent call but flagged manual (renders with a 👤 marker instead of SIM).
The chronological outbound feed is REPLACED by this network view (per-recipient
history covers it; `GET /api/calls` stays for API completeness).

### G.3 Backend additions
1. `POST /api/items/:itemId/call/:recipientId` — directed single call,
   bypassing the ranking loop: draftOffer → voice.placeCall → append attempt,
   addHistory; on accepted: item matched + creditReceived. 404 unknown ids,
   409 if item not `pending`. Returns `{item, attempt}`.
2. `POST /api/items/:itemId/manual/:recipientId` — body `{outcome:
   'accepted'|'declined'|'no_answer', reason?, notes?}` → construct a
   CallAttempt with `manual: true` (ADD optional `manual?: boolean` to
   CallAttempt — narrow additive change, permitted by §3), `simulated: false`,
   transcript = notes as a single agent-line if provided. Same persistence
   semantics as (1). Same 404/409 rules.
3. BOTH endpoints, after an outcome that resolves the last pending item of a
   donation, must run the same finish path as dispatchDonation: compose donor
   callback → donorMessage → donation status `resolved`. (Factor the finish
   check out of the pipeline so all three callers share it.)
4. Vitest coverage: accepted path (matched + credit + history), declined path
   (history + prefs learning window applies), manual flag round-trip, 409 on
   non-pending item, donation auto-resolution when last item closes via a
   directed/manual call.

### G.4 Visual-quality pass ("the dashboard looks like shit")
Applies to every surface, same one-accent rule:
- Type scale locked to 13/14/16/20 with one weight jump (500→650); tabular
  numerals for times/scores; NO monospace outside timestamps.
- 12px spacing grid; panel padding 16; row padding 10×12; radii 12 (panels)
  / 8 (rows); borders 1px at low alpha — kill any double borders.
- Panel headers: title + subtle count badge (e.g. "Inbound · 3", "Network ·
  15"); one quiet icon row max.
- Hover/active states on every clickable row (bg lift + border accent);
  smooth 120ms transitions; focus-visible rings.
- Status dots get a 2px glow of their own color; red cards a 6% red tint.
- Map controls/attribution restyled to theme; thin styled scrollbars;
  empty states one muted line, centered.
Result must look like a professional ops tool at first glance.

### G.5 Guardrails
Scoring/pipeline/API beyond §G.3 unchanged. All tests green. tsc + vitest +
vite build green. Canned e2e < 1s. Item Detail view internals unchanged.
