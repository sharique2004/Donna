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

## H. v1.4 — De-AI visual revamp + Demo page (user feedback)

User verdict: layout is loved — DO NOT change it. But the surface styling
"looks very, very AI generated": the red/green glowing dots and emoji have to
go. Same structure, new skin. Plus a new empty Demo page.

### H.1 Hard bans (the "AI tells")
- **ZERO emojis anywhere.** Every emoji/pictograph glyph is replaced by an
  inline SVG stroke icon (see H.2) or plain text. This includes: channel icons,
  the handshake/cart glyphs in Network rows, the manual-call person marker,
  callback envelope, tune gear, phone glyphs, snowflake — all of them. Audit
  with a regex for non-ASCII in frontend/src before returning.
- **No glowing colored dots.** Kill the dot+glow status language entirely.
- **No glassy translucency/backdrop-blur, no soft shadows-with-glow, no
  gradient buttons, no green-tinted pill fills.**

### H.2 The replacement language (professional dispatch tool)
- **Status becomes typographic + structural, not ornamental:**
  - Items (Inbound): keep the 3px left rule as the only color element; status
    is a small-caps micro-label at line end — `PENDING` (muted), `PLACED`
    (muted green text), `NO TAKERS` (muted red text). Red card keeps a 4% tint
    max. "→ {recipient}" stays as plain text.
  - Network rows: last-call outcome as a micro-label after the name
    (`ACCEPTED` / `DECLINED` / quiet `—` when never called), not a dot.
  - Transcript/manual markers: text tags `SIM` / `MANUAL` / `VAPI` in hairline
    boxes, as the SIM tag already is.
- **Icons:** single inline SVG set (one file `src/icons.tsx`), stroke-based,
  16px, 1.5px stroke, `currentColor`, Lucide-like geometry, muted by default.
  Needed: phone, message-square, mail, footprints/walk, snowflake, gear,
  person, arrow-left, x, plus. No icon fonts, no emoji fallbacks.
- **Surfaces:** opaque panels (near-black, e.g. #101215 on #0b0d0f canvas),
  1px hairline borders at 6–8% white alpha, radius 8 (panels) / 6 (rows).
  Dividers are hairlines, not nested cards.
- **Buttons:** primary = solid accent, radius 6, no glow/gradient; secondary =
  hairline outline, transparent fill. Text labels, sentence case ("Donna, call",
  "Log manual call", "+ Donation" stays).
- **Chips (agreed-to-take, item pills):** hairline-bordered quiet tags —
  transparent fill, muted foreground, radius 4. No colored fills.
- **Type:** system sans; micro-labels 11px/650/+0.06em small caps; body 13–14;
  titles 16/650. Timestamps 12px tabular, muted. The wordmark may get slight
  character (tighter tracking, accent period: "Donna.") but nothing cute.
- Map, layout dimensions, interactions, polling, routes: UNCHANGED.
- Equity + Detail views get the same skin (labels/buttons/borders), no
  structural change. Score bars in Detail stay single-accent thin rules.

### H.3 Demo page (empty mount point)
- Header segmented control becomes `Dispatch | Equity | Demo`.
- New `frontend/src/components/DemoPage.tssx → DemoPage.tsx`: an intentionally
  EMPTY full-bleed container rendered when the Demo tab is active, styled to
  theme (canvas bg), containing exactly one clearly-marked mount slot:
  `<section id="demo-root" data-demo-slot />` plus one muted centered line
  ("Demo") so the tab isn't a black void. A code comment marks it as the
  ingestion point for an externally-built demo page (pipeline exists; content
  arrives later). No fetches, no other chrome.

### H.4 Verification
tsc + vite build green; non-ASCII/emoji regex audit of frontend/src returns
clean (map attribution glyphs and CSS arrows like → ← ✕ in text are allowed
ONLY for →, ←, ✕, ⌀ typographic marks — no pictographic emoji); all three
tabs render.

## I. v1.5 — Map-first Demo stage + routing narrative (user feedback)

User verdict: the map must be the face of the product on BOTH tabs. Tab 1
(Dispatch) is the inbound/outbound console and becomes the DEFAULT view. Tab 2
(Demo) currently hides the map behind an opaque card grid — that is wrong. The
demo must play out ON the map: the inbound supplier call transcript forms, a
routing decision is made and *seen* (direct-to-pantry vs stored-into-inventory),
the outbound call transcript forms, the origin and destination light up with a
route, and the supplier gets a drafted callback message. §B–§H rules (one
accent, ≤2-line rows, humanize() everywhere, zero emojis, flat opaque surfaces,
no backdrop-blur) all still bind.

### I.0 Hard constraints (from the codebase — verified 2026-07-16)
- Backend is UNTOUCHED in this pass. No depot/inventory concept exists there
  (only `ENV.foodBankName`, a display string); `distanceMiles` is
  pickup→recipient only. The direct-vs-store narrative is presentation-layer
  ONLY, derived deterministically client-side. Say so in code comments.
- `/api/live` is populated only by VAPI webhooks — ALWAYS empty in sim mode.
  Sim dispatch is synchronous and instant (zero built-in delays). All demo
  pacing is client-owned: dispatch first, then REPLAY the returned attempts.
- `pickupLat/pickupLng` are optional — every map feature must no-op gracefully
  when they are absent.
- Items stay `pending` after a decline; `dialing` is a transient object; there
  is no `declined` item status. `awaiting_triage` occurs only for real inbound
  VAPI calls — the canned path lands at `scored`.
- No new npm dependencies; no CDN/runtime-network assets. Frontend files only
  (`frontend/src/**`, `frontend/index.html`).

### I.1 Global
- **Default view = `dispatch`** (App.tsx currently boots into `demo`). Header
  segmented control stays `Dispatch | Demo`.
- **Display face:** bundle Space Grotesk (variable or 500/700 woff2, OFL
  license file alongside) under `frontend/src/assets/fonts/`, `@font-face` in
  styles.css, exposed as `--display`. Used ONLY for: wordmark, panel titles,
  seg control, stat numbers, stage phase labels. Body copy stays `--sans`.
  Font stack must fall back to the current system stack so a missing asset
  degrades silently.
- **New tokens** in `:root`: `--flow-direct` (= `--hot`), `--flow-store`
  `#4fb3a9`, `--route-dim rgba(231,233,236,0.22)`. No other token churn.
- **Map vignette:** one non-interactive overlay div inside `.map-hero`
  (`pointer-events:none`, radial-gradient, edges max ~35% black) so floating
  panels read against tiles. NOT backdrop-blur (§H ban stands).
- **Food bank home base:** `theme.ts` exports
  `FOOD_BANK = { name: 'SF-Marin Food Bank', lat: 37.7541, lng: -122.3924 }`
  (display-only; comment that the backend has no depot). Rendered on both tabs
  as a small diamond marker with a quiet label.
- **Routing verdict util** in `theme.ts`:
  `routeVia(hoursToSpoil: number): 'direct' | 'store'` →
  `hoursToSpoil >= 168 ? 'store' : 'direct'` (7-day threshold), plus
  `verdictCopy()` returning the one-line reason, e.g. direct: "spoils in 48h —
  routed straight from the supplier"; store: "shelf-stable — taken into
  inventory, allocated from the warehouse". Canned scenario verdicts:
  strawberries 48h → direct, bread 24h → direct, beans 2160h → store.

### I.2 Demo bus (new `frontend/src/demoBus.ts`)
A tiny module-scope store with subscribe/get/set + a `useDemoBus()` hook via
`useSyncExternalStore`. Shape:
`{ active: boolean, pickup?: {lat,lng,label}, routes: Route[], focusRecipientIds: string[], failedAtPickup?: boolean }`
where `Route = { id, kind: 'direct'|'store-leg1'|'store-leg2', from: [number,number], to: [number,number] }`.
DemoStage writes it; MapView reads it. Neither imports the other — the stage
stays crash-isolated from the console (preserve the existing doc comment's
intent in DemoStage.tsx).

### I.3 MapView additions
- `<DemoLayer/>` rendered inside `MapContainer`: subscribes to the bus;
  renders the food-bank diamond (always), route arcs, and endpoint pulses;
  when `active`, recipient pins not in `focusRecipientIds` drop to ~25%
  fillOpacity; FitBounds yields to the bus (fit to route endpoints + food
  bank while routes exist).
- **Arcs:** quadratic bezier (control point offset perpendicular ~15% of the
  chord), 64 samples, react-leaflet `Polyline`. Draw-in ≈900ms by slicing the
  sampled points on rAF (do not fight leaflet's SVG internals with CSS).
  `direct` = solid `--flow-direct`, weight 3; `store-leg1` solid and
  `store-leg2` dashed in `--flow-store`. A failed item = pulsing muted-red
  ring at the pickup pin, no route.
- **Dispatch tab routes**, same Arc component, from `useDonna` state directly:
  matched item selected → its full route (via warehouse when
  `routeVia(item) === 'store'`: pickup→FOOD_BANK, FOOD_BANK→recipient);
  pending item + a selected recipient → thin dashed preview pickup→recipient
  in `--route-dim`.
- Legend gains two route swatches (direct / via warehouse). Keep the ramp.

### I.4 Demo tab — choreographed stage over the visible map
`.stage` becomes a transparent, `pointer-events:none` layer (map pans
underneath); panels are opaque floating surfaces (`--panel`, hairline border,
radius 8, `--shadow`, `pointer-events:auto`) that enter with a 160ms
translate+fade. Kill the `.stage-grid` nth-child hack entirely.

Layout: left 340px panel **"Inbound — supplier line"** (caller identity +
typewriter transcript); right 340px panel **"Outbound — Donna calling"**
(callee identity + typewriter transcript; swaps per call; finally swaps to the
Draft message card); bottom-center strip (≤720px) holding item cards with
verdict micro-labels (`DIRECT` in `--flow-direct` / `STORE` in `--flow-store` +
one verdictCopy line) and the stage controls.

**Choreographer** — a client state machine
`idle → inbound → parsed → gate → calling(i) → callback → done`:
1. *idle*: map + food bank marker, one muted line, primary **"Run demo"**
   (calls `api.canned()`).
2. *inbound*: left panel types out `parseRaw(rawText)` at ~550ms/line; pickup
   pin drops via the bus. A quiet "Skip" control fast-forwards any phase.
3. *parsed*: item cards stagger in (~250ms apart) with verdict labels.
4. *gate*: the human gate (PRD §10): **"Approve & dispatch"** primary button.
   On click call `api.dispatch(id)` — it returns the fully-resolved donation;
   do NOT render outcomes yet.
5. *calling(i)*: replay attempts item-by-item: right panel shows the recipient
   name, types the attempt transcript at ~500ms/line, lands the outcome
   micro-label; on accept the bus draws the route (direct: pickup→recipient;
   store: pickup→FB, then FB→recipient chained ~300ms later). Declines move to
   the next attempt. Bread (canned): no route, `failedAtPickup` pulse,
   `NO TAKERS` label.
6. *callback*: right panel swaps to the **Draft message card** — compose-style:
   "To {donorName} · {org if parseable}", "via text · {sourceContact}" (the
   canned channel is voice/SMS — label honestly per channel, email framing
   only when channel is email), body = `donorMessage` typed fast (~30ms/word),
   then a quiet "Ready to send — Delivered" state line.
7. *done*: summary chips in the strip (`2 placed · 1 unplaceable · 5,200 lbs
   moved`), routes persist. "Reset" runs `api.reset()` and returns to idle.

**Live-mode compatibility:** keep the 1s self-contained poll. If `/api/live`
has lines (real VAPI), stream them into the phase-appropriate panel instead of
replay pacing; donations at `awaiting_triage` surface the gate wired to
`api.approve` + polling (existing behavior). A `donorMessage` beginning
"Dispatch failed" renders as a plain error line, never in the compose card.

### I.5 Dispatch tab polish (no structural change)
Display face on titles/wordmark/seg; panel-enter transitions; hover polish;
Feed cards for `matched` items gain a small route glyph + "→ {recipient}"
(already §G); map routes per I.3. Everything else — §G layout, Detail
internals, polling, endpoints — unchanged.

### I.6 Webflow comp (design source of record)
On the Webflow site "Donna" (6a59a21adef5d659dbfb5802): a "Design v1.5" page
set — tokens board (colors/type/radii), an Operations screen comp, and a
4-beat Demo storyboard — built with Webflow styles mirroring the tokens above.
Static comp only; publish only with explicit user approval.

### I.7 Verification
`npx tsc --noEmit` + `vite build` green in frontend/; `git diff` clean outside
`frontend/` and `docs/`; §H.4 non-ASCII audit still clean; canned run through
the UI end-to-end (inbound → verdicts → gate → replayed calls → routes →
draft card) with screenshots of both tabs; full demo replay ≤90s with Skip
available at every phase.
