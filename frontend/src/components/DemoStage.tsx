import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type {
  CallOutcome, Donation, DonationItem, EnrichedDonation, ItemStatus, LiveCall, Mode, Recipient,
} from '../types';
import type { DemoBus, DemoRoute } from '../demoBus';
import { setDemoBus, resetDemoBus } from '../demoBus';
import { FOOD_BANK, routeVia, verdictCopy, humanize } from '../theme';
import { ChannelIcon, Phone, Mail, MessageSquare } from '../icons';

/**
 * The Demo tab — a map-first stage with ONE set of visual panels (Inbound,
 * Outbound/Draft, verdict strip, map bus writes) and TWO data drivers (§J.1):
 *
 *  - REPLAY driver (§I.4 choreographer): the canned path. The backend is instant
 *    in sim mode (dispatch is synchronous, sim /api/live is empty), so ALL pacing
 *    is client-owned REPLAY — "Run demo" pulls the canned scored donation,
 *    "Approve & dispatch" resolves it in one call, and we re-enact the returned
 *    attempts item-by-item.
 *  - LIVE driver (§J.2): real vapi calls render the SAME panels directly from the
 *    polled server state (1s cadence). No scripted sleeps — the phone call itself
 *    is the pacing. Captions stream from /api/live, the donation pops at
 *    awaiting_triage after hangup with the human gate, `.dialing` drives the
 *    Outbound panel with an elapsed timer (dialing persists for MINUTES on real
 *    calls), and attempts landing write demoBus routes exactly like the replay.
 *
 * The routing narrative (direct vs via-warehouse) is presentation-only — the
 * backend has no depot; see theme.ts routeVia — and is written to the demo bus.
 *
 * Deliberately self-contained (own polling, own state) rather than wired into
 * DonnaProvider: the map/console keeps working untouched, and a bug in here on
 * demo night can't take that down with it. The demo bus is the ONLY shared
 * surface with MapView; neither module imports the other.
 */

/**
 * §L.1 — the pipeline rail splits what the choreographer used to play as one
 * 'inbound' beat into three (call → transcribing → intelligence), because the
 * rail has to SHOW the machine thinking; a stage that never renders is a stage
 * a judge doesn't know happened. These are display-only beats: no api call, no
 * demo-bus write, nothing downstream reads them. The LIVE driver has no
 * equivalent — a real call gives us captions, not a transcription phase — so it
 * maps its own server statuses onto the same rail (railIndexLive).
 */
type Phase =
  | 'idle' | 'inbound' | 'transcribing' | 'intelligence'
  | 'parsed' | 'gate' | 'calling' | 'callback' | 'done';
type Line = { speaker: string; text: string };
const FB: [number, number] = [FOOD_BANK.lat, FOOD_BANK.lng];

/**
 * The stored rawText is the inbound dialogue. Lines explicitly prefixed
 * `ai:`/`assistant:` are Donna; `user:` is the donor. UNPREFIXED lines are the
 * canned voicemail monologue spoken in the DONOR's own voice, so the fallback
 * attributes to the donor side ('recipient') — NEVER to Donna. The caller
 * (InboundPanel) resolves the human label to the donor name.
 */
function parseRaw(raw?: string): Line[] {
  if (!raw) return [];
  return raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^(ai|assistant|user)\s*:\s*(.*)$/i.exec(l);
    if (!m) return { speaker: 'recipient', text: l };
    const who = m[1].toLowerCase();
    return { speaker: who === 'ai' || who === 'assistant' ? 'agent' : 'recipient', text: m[2] };
  });
}

interface CallView {
  recipientName: string; itemName: string;
  lines: Line[]; n: number; outcome?: CallOutcome; reason?: string;
  elapsedMs?: number;   // §J.2 — live dialing timer (absent in replay)
}
interface DraftView { done: boolean; text: string; error: boolean; }

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function DemoStage(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [enriched, setEnriched] = useState<EnrichedDonation | null>(null);
  const [dispatched, setDispatched] = useState<Donation | null>(null);
  const [recipsById, setRecipsById] = useState<Record<string, Recipient>>({});
  const [inboundN, setInboundN] = useState(0);
  const [itemsN, setItemsN] = useState(0);
  const [call, setCall] = useState<CallView | null>(null);
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [startedCanned, setStartedCanned] = useState(false);
  // How many item cards may reveal their PLACED / NO TAKERS outcome during the
  // replay. Cards derive status from REPLAY PROGRESS (§I.4 step 5) — an item stays
  // pending (verdict only) until its own call replay completes — NOT from the
  // already-resolved dispatch response (which would flip every card the instant
  // Approve lands, leaking the ending; ISSUE 1).
  const [replayItemsDone, setReplayItemsDone] = useState(0);

  // Live driver state (§J.2): the 1s self-contained poll of /api/donations +
  // /api/live + /api/health. In sim mode /api/live is always empty and canned
  // lands at 'scored', so the live driver stays dormant — it only wakes for a
  // REAL vapi call (inbound at awaiting_triage, or a canned approve that returned
  // an in-flight snapshot under live voice — see approveDispatch's handoff).
  const [mode, setMode] = useState<Mode | null>(null);
  const [donations, setDonations] = useState<Donation[]>([]);
  const [liveCalls, setLiveCalls] = useState<LiveCall[]>([]);
  const [now, setNow] = useState<number>(Date.now());
  // The donation we are actively following through to 'resolved' after crossing a
  // gate (real inbound approve, or a canned approve that handed off to live).
  const [followId, setFollowId] = useState<string | null>(null);

  // Choreographer control: runIdRef invalidates a running replay on reset/unmount;
  // skipRef fast-forwards the current phase (every sleep resolves instantly).
  const runIdRef = useRef(0);
  const skipRef = useRef(false);
  // Live setTimeout resolvers, so ONE Skip press flushes the whole current phase at
  // once (§I.4 Skip) instead of releasing one queued step per animation frame.
  const pendingSleeps = useRef<Set<() => void>>(new Set());

  // Wall-clock pacing via setTimeout — NOT requestAnimationFrame. rAF is throttled
  // by the heavy Leaflet route-draw animations repainting the map UNDER the stage
  // (MapView draws each polyline over ~900ms on its own rAF loop), which stretched
  // every "30ms/word" / "500ms/line" step into seconds. setTimeout fires on the
  // wall clock regardless of render load.
  const sleep = (ms: number): Promise<void> => new Promise((res) => {
    // Already skipping this phase → resolve immediately; the remaining loop drains
    // on the microtask queue within one tick, so only the final state paints.
    if (skipRef.current) { res(); return; }
    let id = 0;
    const finish = () => {
      window.clearTimeout(id);
      pendingSleeps.current.delete(finish);
      res();
    };
    id = window.setTimeout(finish, ms);
    pendingSleeps.current.add(finish);
  });

  // Resolve every in-flight sleep at once — the Skip short-circuit for a phase.
  const flushSleeps = () => {
    const fns = [...pendingSleeps.current];
    pendingSleeps.current.clear();
    for (const f of fns) f();
  };

  useEffect(() => { void api.listRecipients().then((rs) => {
    const m: Record<string, Recipient> = {};
    for (const r of rs) m[r.id] = r;
    setRecipsById(m);
  }).catch(() => {}); }, []);

  // §J.2 poll: donations + live captions + health mode, every 1s. `now` ticks on
  // the same cadence so the live dialing elapsed timer advances.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const [lv, ds, h] = await Promise.all([api.live(), api.listDonations(), api.health()]);
        if (!alive) return;
        setLiveCalls(lv.calls ?? []);
        setDonations(ds || []);
        setMode(h.mode ?? null);
        setNow(Date.now());
      } catch { /* transient — the console owns hard error surfacing */ }
    };
    void poll();
    const id = window.setInterval(() => { void poll(); }, 1000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  // Unmount: invalidate any running replay and clear the map narrative.
  useEffect(() => () => { runIdRef.current++; resetDemoBus(); }, []);

  /* ------- choreography: canned run (inbound → parsed → gate) ------- */
  async function runAfterCanned(enr: EnrichedDonation) {
    const rid = ++runIdRef.current;
    skipRef.current = false;
    const d = enr.donation;
    if (d.pickupLat != null && d.pickupLng != null) {
      setDemoBus({ active: true, pickup: { lat: d.pickupLat, lng: d.pickupLng, label: d.donorName ?? 'Pickup' }, routes: [], focusRecipientIds: [], failedAtPickup: false, heldAtFoodBank: false });
    } else {
      setDemoBus({ active: true, routes: [], focusRecipientIds: [], failedAtPickup: false, heldAtFoodBank: false });
    }
    setPhase('inbound');
    const lines = parseRaw(d.rawText);
    for (let i = 1; i <= lines.length; i++) {
      setInboundN(i); await sleep(550); if (runIdRef.current !== rid) return;
    }
    // §L.1 display-only beats. Each is its own Skip unit (a phase boundary
    // resets the flag), so Skip during the ring doesn't blow past the read-out.
    skipRef.current = false;
    setPhase('transcribing');
    await sleep(900); if (runIdRef.current !== rid) return;
    skipRef.current = false;
    setPhase('intelligence');
    await sleep(1500); if (runIdRef.current !== rid) return;

    skipRef.current = false; // phase boundary — a Skip in 'intelligence' must not bleed into 'parsed'
    setPhase('parsed');
    for (let i = 1; i <= d.items.length; i++) {
      setItemsN(i); await sleep(250); if (runIdRef.current !== rid) return;
    }
    // Enter the human gate (PRD §10) with a clean skip flag. The gate has NO
    // timers and never calls api.dispatch — only the "Approve & dispatch" button
    // (approveDispatch) may cross it. Skip is not even offered during 'gate'.
    skipRef.current = false;
    setPhase('gate');
  }

  /* ------- choreography: replay resolved attempts (calling → callback → done) ------- */
  async function runAfterDispatch(disp: Donation) {
    const rid = ++runIdRef.current;
    skipRef.current = false;
    setPhase('calling');
    setReplayItemsDone(0); // cards start pending; each flips as its own call lands
    const pickupPt: [number, number] | null =
      disp.pickupLat != null && disp.pickupLng != null ? [disp.pickupLat, disp.pickupLng] : null;
    const routes: DemoRoute[] = [];
    const focus: string[] = [];

    for (const item of disp.items) {
      // §K.1 — a held item gets NO outbound call replay: draw the pickup→food-bank
      // leg (store-leg1 style) and leave a persistent teal pulse resting at the food
      // bank, then mark the card done (its IN INVENTORY label is status-driven).
      if (item.status === 'held') {
        if (pickupPt) {
          routes.push({ id: `${item.id}-hold`, kind: 'store-leg1', from: pickupPt, to: FB });
          setDemoBus({ routes: [...routes], heldAtFoodBank: true });
          await sleep(300); if (runIdRef.current !== rid) return;
        } else {
          setDemoBus({ heldAtFoodBank: true });
        }
        setReplayItemsDone((n) => n + 1);
        continue;
      }
      let accepted = false;
      for (const a of item.attempts) {
        // Each call is its own Skip unit: one Skip press fast-forwards ONLY this
        // call's typewriter, not the rest of the replay (§bug2c).
        skipRef.current = false;
        focus.push(a.recipientId);
        setDemoBus({ focusRecipientIds: [...focus] });
        setCall({ recipientName: a.recipientName, itemName: item.item, lines: a.transcript, n: 0, reason: a.reason });
        await sleep(160); if (runIdRef.current !== rid) return;
        for (let k = 1; k <= a.transcript.length; k++) {
          setCall((c) => (c ? { ...c, n: k } : c)); await sleep(500);
          if (runIdRef.current !== rid) return;
        }
        setCall((c) => (c ? { ...c, outcome: a.outcome, reason: a.reason } : c));
        await sleep(650); if (runIdRef.current !== rid) return;
        if (a.outcome === 'accepted') {
          accepted = true;
          const rec = recipsById[a.recipientId];
          const recPt: [number, number] | null = rec ? [rec.lat, rec.lng] : null;
          if (routeVia(item.hoursToSpoil) === 'store' && pickupPt && recPt) {
            routes.push({ id: `${item.id}-l1`, kind: 'store-leg1', from: pickupPt, to: FB });
            setDemoBus({ routes: [...routes] });
            await sleep(300); if (runIdRef.current !== rid) return;
            routes.push({ id: `${item.id}-l2`, kind: 'store-leg2', from: FB, to: recPt });
            setDemoBus({ routes: [...routes] });
          } else if (pickupPt && recPt) {
            routes.push({ id: `${item.id}-d`, kind: 'direct', from: pickupPt, to: recPt });
            setDemoBus({ routes: [...routes] });
          }
          await sleep(500); if (runIdRef.current !== rid) return;
          break;
        }
      }
      if (!accepted && item.attempts.length > 0) {
        setDemoBus({ failedAtPickup: true });
        await sleep(400); if (runIdRef.current !== rid) return;
      }
      // This item's call replay is complete — now its card may show its outcome.
      setReplayItemsDone((n) => n + 1);
    }

    skipRef.current = false; // phase boundary — Skip in 'calling' must not bleed into the draft
    setPhase('callback');
    setCall(null);
    // A donorMessage beginning "Dispatch failed" is an error, never a compose card.
    const msg = (disp.donorMessage ?? '').trim();
    const isErr = msg === '' || /^dispatch failed/i.test(msg);
    if (isErr) {
      setDraft({ done: true, text: msg || 'Dispatch failed — no message composed.', error: true });
    } else {
      setDraft({ done: false, text: '', error: false });
      const words = msg.split(/\s+/);
      let acc = '';
      for (let w = 0; w < words.length; w++) {
        acc = acc ? `${acc} ${words[w]}` : words[w];
        setDraft({ done: false, text: acc, error: false });
        await sleep(30); if (runIdRef.current !== rid) return;
      }
      await sleep(400); if (runIdRef.current !== rid) return;
      setDraft({ done: true, text: msg, error: false });
    }
    await sleep(500); if (runIdRef.current !== rid) return;
    skipRef.current = false; // phase boundary — leave 'done' with a clean skip flag
    setPhase('done');
  }

  /* ------- controls ------- */
  async function runDemo() {
    setErr(null);
    try {
      const enr = await api.canned();
      setEnriched(enr); setDispatched(null); setStartedCanned(true); setFollowId(null);
      setInboundN(0); setItemsN(0); setCall(null); setDraft(null); setReplayItemsDone(0);
      void runAfterCanned(enr);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function approveDispatch() {
    if (!enriched) return;
    setErr(null);
    try {
      const disp = await api.dispatch(enriched.donation.id);
      setDispatched(disp);
      // §J.3 guard: sim returns a fully-resolved donation → run the replay. Live
      // voice returns an IN-FLIGHT snapshot (status 'dispatching' or pending items
      // still open) — hand off to the live driver, which paces off the poll, and
      // do NOT re-enact (there is nothing resolved to re-enact yet).
      const unresolved = disp.status === 'dispatching'
        || disp.status === 'awaiting_triage'
        || disp.items.some((i) => i.status === 'pending');
      if (unresolved) {
        setFollowId(disp.id);
      } else {
        void runAfterDispatch(disp);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  // §K.1 — HOLD one pending item at the food bank (the "Add to inventory" gate
  // action). Patch the staged donation locally so the card flips to IN INVENTORY,
  // and if that leaves zero pending items there is nothing to dispatch — resolve
  // the donation so the flow still proceeds to the callback.
  async function holdOne(itemId: string) {
    if (!enriched) return;
    setErr(null);
    try {
      await api.holdItem(itemId);
      const patched: EnrichedDonation = {
        ...enriched,
        donation: {
          ...enriched.donation,
          items: enriched.donation.items.map((i) =>
            i.id === itemId ? { ...i, status: 'held' as ItemStatus } : i),
        },
      };
      setEnriched(patched);
      const pending = patched.donation.items.filter((i) => i.status === 'pending').length;
      if (pending === 0) void approveDispatch();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function resetStage() {
    runIdRef.current++;
    skipRef.current = false;
    resetDemoBus();
    setEnriched(null); setDispatched(null); setStartedCanned(false); setFollowId(null);
    setInboundN(0); setItemsN(0); setCall(null); setDraft(null); setReplayItemsDone(0);
    setPhase('idle'); setErr(null);
    try { await api.reset(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  const skip = () => { skipRef.current = true; flushSleeps(); };

  /* ---------------- live driver selection (§J.2) --------------- */
  const vapi = mode?.voice === 'vapi';
  // The active live donation: the one we are following (after a gate) if present,
  // else the newest in a live-active status. Real inbound donations appear fully
  // parsed at awaiting_triage only AFTER hangup.
  const liveDon = useMemo<Donation | null>(() => pickLiveDon(donations, followId), [donations, followId]);
  // Captions bound to the phase (§J.5): a real dispatch places one call at a time,
  // but if more than one live call exists, prefer the newest for the active panel.
  const liveCaptions: Line[] = liveCalls.length ? (liveCalls[liveCalls.length - 1].lines ?? []) : [];

  // A canned REPLAY is the active driver while a canned run is going and we have NOT
  // handed off to the live driver (no followId). While it runs, the live driver must
  // NOT paint polled donation end-state over the choreography — that leak flipped the
  // item cards to their outcomes before the calls replayed (ISSUE 1 / §I.4).
  const replayActive = startedCanned && followId == null;

  // Live active when we are following a gated donation through, OR (vapi mode, no
  // canned replay in flight) there is a live donation or streaming captions — but
  // NEVER while a replay is the active driver.
  const liveActive = !replayActive && ((followId != null && liveDon != null)
    || (vapi === true && !startedCanned && (liveDon != null || liveCalls.length > 0)));

  // Map bus writes for live (§J.2): recompute the full narrative from the polled
  // donation each tick — idempotent, same visuals as the replay. Keyed on a cheap
  // signature so it only fires when the donation's routing-relevant shape changes.
  const liveSig = liveDon ? liveSignature(liveDon) : (liveActive ? 'pretriage' : '');
  useEffect(() => {
    if (!liveActive) return;
    if (liveDon) setDemoBus(busFromLiveDonation(liveDon, recipsById));
    else setDemoBus({ active: true }); // pre-triage: caller on the line, no route yet
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveActive, liveSig, recipsById]);

  async function approveLive(id: string) {
    setFollowId(id);      // follow this donation from the gate through to resolved
    setErr(null);
    try { await api.approve(id); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  if (liveActive) {
    return (
      <LiveStage
        donation={liveDon}
        captions={liveCaptions}
        now={now}
        recipsById={recipsById}
        onApprove={approveLive}
        onReset={() => void resetStage()}
        err={err}
      />
    );
  }

  /* ---------------- canned choreography render ---------------- */
  const donation = dispatched ?? enriched?.donation ?? null;
  const items = donation?.items ?? [];
  const inboundLines = parseRaw(enriched?.donation.rawText).slice(0, inboundN);
  const showInbound = phase !== 'idle' && donation != null;
  // Items stay hidden until the intelligence beat lands — showing a parsed item
  // while the rail still says "Transcribing" would give away the ending (§I.4).
  const preParse = phase === 'inbound' || phase === 'transcribing' || phase === 'intelligence';
  const visibleItems = preParse ? 0 : phase === 'parsed' ? itemsN : items.length;
  const animating = preParse || phase === 'parsed' || phase === 'calling' || phase === 'callback';

  return (
    <div className="stage">
      {phase !== 'idle' && <PipelineRail index={railIndex(phase)} />}

      {showInbound && donation && (
        <InboundPanel donation={donation} lines={inboundLines} />
      )}

      {phase === 'calling' && call && <OutboundCallPanel call={call} />}
      {(phase === 'callback' || phase === 'done') && draft && donation && (
        <DraftPanel donation={donation} draft={draft} />
      )}

      <div className="stage-strip">
        {phase !== 'idle' && (
          <div className="strip-phase display-face">{phaseLabel(phase)}</div>
        )}

        {visibleItems > 0 && (
          <div className="vstrip">
            {items.slice(0, visibleItems).map((it, idx) => (
              <VerdictCard
                key={it.id}
                item={it}
                resolved={dispatched && idx < replayItemsDone ? resolveItem(it) : null}
                onHold={phase === 'gate' && it.status === 'pending' ? () => void holdOne(it.id) : undefined}
              />
            ))}
          </div>
        )}

        {phase === 'done' && dispatched && <SummaryChips donation={dispatched} />}

        <div className="stage-controls">
          {phase === 'idle' && (
            <>
              <span className="muted">
                {vapi
                  ? 'Line open — waiting for a call'
                  : 'Play the inbound call, the routing verdict, the human gate, and Donna working the phones.'}
              </span>
              <button className="btn-primary" onClick={() => void runDemo()}>Run demo</button>
            </>
          )}
          {phase === 'gate' && (() => {
            const pending = items.filter((i) => i.status === 'pending').length;
            const anyHeld = items.some((i) => i.status === 'held');
            if (pending === 0) {
              // §K.1 — every item held: nothing to dispatch; the donation resolves
              // and the flow carries on to the callback on its own.
              return <span className="muted">All items held in inventory.</span>;
            }
            return (
              <>
                <span className="muted">Held for review — nothing is called until you approve.</span>
                <button className="btn-primary" onClick={() => void approveDispatch()}>
                  Approve &amp; dispatch{anyHeld ? ` (${pending})` : ''}
                </button>
              </>
            );
          })()}
          {phase === 'done' && (
            <button className="btn-quiet" onClick={() => void resetStage()}>Reset</button>
          )}
          {animating && (
            <button className="btn-quiet" onClick={skip}>Skip</button>
          )}
        </div>
      </div>

      {err && <div className="stage-err">backend: {err}</div>}
    </div>
  );
}

function phaseLabel(p: Phase): string {
  switch (p) {
    case 'inbound': return 'Inbound call';
    case 'transcribing': return 'Transcribing';
    case 'intelligence': return 'Running intelligence';
    case 'parsed': return 'Routing verdict';
    case 'gate': return 'Human gate';
    case 'calling': return 'Calling recipients';
    case 'callback': return 'Drafting callback';
    case 'done': return 'Dispatch complete';
    default: return '';
  }
}

/* ------------------------------------------------------------ pipeline rail */

/**
 * §L.1 — the pipeline rail: seven glass capsules across the top of the stage,
 * threaded by a progress track with a lit bead at the front edge.
 *
 * This is the one place in the v1.4 skin that uses glass and glow (styles.css:5
 * forbids both everywhere else). That is deliberate and scoped: the rail floats
 * OVER the live map, so a blurred surface reads as altitude in a way an opaque
 * panel can't, and the exception stops at `.prail`.
 *
 * `live` marks the two stages where a human is actually on a phone — the only
 * places a green dot may appear. `spin` marks the one stage where the machine is
 * working with nothing to show; it gets the ring.
 */
const RAIL: { key: string; n: string; label: string; live?: true; spin?: true }[] = [
  { key: 'inbound',      n: '01', label: 'Inbound call',    live: true },
  { key: 'transcribing', n: '02', label: 'Transcribing' },
  { key: 'intelligence', n: '03', label: 'Intelligence',    spin: true },
  { key: 'parsed',       n: '04', label: 'What they offer' },
  { key: 'gate',         n: '05', label: 'Your call' },
  { key: 'calling',      n: '06', label: 'Outbound call',   live: true },
  { key: 'callback',     n: '07', label: 'Call donor back' },
];

/** Rail position for the canned choreographer. -1 = idle, 7 = every stage done. */
function railIndex(p: Phase): number {
  if (p === 'idle') return -1;
  if (p === 'done') return RAIL.length;
  return RAIL.findIndex((r) => r.key === p);
}

function PipelineRail({ index }: { index: number }) {
  // The bead sits at the leading edge of the ACTIVE capsule, so a completed run
  // (index === RAIL.length) fills the track outright.
  const pct = Math.max(0, Math.min(1, (index + 1) / RAIL.length)) * 100;
  return (
    <div className="prail" role="group" aria-label="Dispatch pipeline">
      {/* prail-in is width:max-content so the track and the capsules share ONE
          scroll width — the track must span the capsules, not the viewport. */}
      <div className="prail-in">
      <div className="prail-track"><div className="prail-fill" style={{ right: `${100 - pct}%` }} /></div>
      <div className="prail-row">
        {RAIL.map((r, i) => {
          const state = i < index ? 'done' : i === index ? 'act' : 'idle';
          return (
            <div key={r.key} className={`pnode ${state}`} aria-current={state === 'act' ? 'step' : undefined}>
              <span className="pn-k">
                {r.n}
                {state === 'act' && r.spin && <span className="pn-ring" aria-hidden="true" />}
                {state === 'done' && <span className="pn-check" aria-hidden="true">✓</span>}
              </span>
              <span className="pn-l">{r.label}</span>
              {state === 'act' && r.live && (
                <span className="pn-live"><i aria-hidden="true" />Live call</span>
              )}
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}

/** Accepted → placed at recipient; otherwise no takers. */
function resolveItem(it: DonationItem): { ok: boolean; recipientName?: string } {
  const acc = it.attempts.find((a) => a.outcome === 'accepted');
  if (acc || it.status === 'matched') return { ok: true, recipientName: acc?.recipientName };
  return { ok: false };
}

/** Live per-item resolution: placed once matched, no-takers once unplaceable, else pending. */
function liveResolveItem(it: DonationItem): { ok: boolean; recipientName?: string } | null {
  if (it.status === 'matched') {
    const acc = it.attempts.find((a) => a.outcome === 'accepted');
    return { ok: true, recipientName: acc?.recipientName };
  }
  if (it.status === 'unplaceable') return { ok: false };
  return null;
}

/* ------------------------------------------------------------- inbound */

function InboundPanel({ donation, lines }: { donation: Donation; lines: Line[] }) {
  return (
    <section className="stage-panel inbound">
      <header className="sp-head">
        <span className="sp-title display-face">Inbound — supplier line</span>
      </header>
      <div className="sp-who">
        <ChannelIcon channel={donation.sourceChannel} size={14} />
        <span className="sp-name">{donation.donorName ?? 'Supplier'}</span>
        <span className="sp-sub">{humanize(donation.sourceChannel)} · {donation.sourceContact}</span>
      </div>
      {donation.pickupLocation && <div className="sp-loc">Pickup · {donation.pickupLocation}</div>}
      <Transcript lines={lines} humanLabel={donation.donorName ?? 'Donor'} />
    </section>
  );
}

/* ------------------------------------------------------------ outbound */

function OutboundCallPanel({ call }: { call: CallView }) {
  return (
    <section className="stage-panel outbound">
      <header className="sp-head">
        <span className="sp-title display-face">Outbound — Donna calling</span>
        {!call.outcome && (
          <span className="sp-live">
            {call.elapsedMs != null ? `On call · ${fmtElapsed(call.elapsedMs)}` : 'On call'}
          </span>
        )}
      </header>
      <div className="sp-who">
        <Phone size={14} />
        <span className="sp-name">{call.recipientName}</span>
        <span className="sp-sub">re {call.itemName}</span>
      </div>
      <Transcript lines={call.lines.slice(0, call.n)} humanLabel="Recipient" />
      {call.outcome && (
        <div className="sp-outcome">
          <span className={`status-tag ${call.outcome}`}>{humanize(call.outcome).toUpperCase()}</span>
          {call.reason && <span className="sp-reason">{call.reason}</span>}
        </div>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- draft */

function DraftPanel({ donation, draft }: { donation: Donation; draft: DraftView }) {
  const channel = donation.sourceChannel;
  const via = channel === 'email' ? 'via email' : 'via text';
  const Glyph = channel === 'email' ? Mail : MessageSquare;
  if (draft.error) {
    return (
      <section className="stage-panel outbound">
        <header className="sp-head"><span className="sp-title display-face">Outbound — callback</span></header>
        <p className="draft-err">{draft.text}</p>
      </section>
    );
  }
  return (
    <section className="stage-panel outbound">
      <header className="sp-head">
        <span className="sp-title display-face">Outbound — draft to supplier</span>
      </header>
      <div className="sp-who">
        <Glyph size={14} />
        <span className="sp-name">To {donation.donorName ?? 'the supplier'}</span>
      </div>
      <div className="sp-sub draft-meta">{via} · {donation.sourceContact}</div>
      <div className="draft-body">{draft.text}</div>
      <div className="draft-state">{draft.done ? 'Ready to send — delivered' : 'Composing…'}</div>
    </section>
  );
}

/* --------------------------------------------------------- verdict card */

function VerdictCard({ item, resolved, onHold }: {
  item: DonationItem; resolved: { ok: boolean; recipientName?: string } | null;
  onHold?: () => void;
}) {
  const via = routeVia(item.hoursToSpoil);
  const held = item.status === 'held';
  return (
    <div className="vcard">
      <div className="vc-top">
        <span className="vc-name">{item.item}</span>
        <span className="vc-qty">{item.qtyLbs.toLocaleString()} lbs</span>
      </div>
      <div className="vc-mid">
        {held ? (
          <span className="status-tag held">IN INVENTORY</span>
        ) : (
          <>
            <span className={`vc-verdict ${via}`}>{via === 'store' ? 'STORE' : 'DIRECT'}</span>
            {resolved && (
              <span className={`status-tag ${resolved.ok ? 'placed' : 'unplaceable'}`}>
                {resolved.ok ? 'PLACED' : 'NO TAKERS'}
              </span>
            )}
          </>
        )}
      </div>
      <div className="vc-copy">{held ? 'held in inventory at the food bank' : verdictCopy(item)}</div>
      {resolved?.ok && resolved.recipientName && <div className="vc-dest">→ {resolved.recipientName}</div>}
      {onHold && (
        <button className="btn-quiet vc-hold" onClick={onHold}>Add to inventory</button>
      )}
    </div>
  );
}

/* -------------------------------------------------------- summary chips */

function SummaryChips({ donation }: { donation: Donation }) {
  const placed = donation.items.filter((i) => i.attempts.some((a) => a.outcome === 'accepted') || i.status === 'matched');
  const held = donation.items.filter((i) => i.status === 'held');
  const unplaceable = donation.items.length - placed.length - held.length;
  const lbs = placed.reduce((s, i) => s + i.qtyLbs, 0);
  return (
    <div className="summary-chips">
      <span className="schip">{placed.length} placed</span>
      {held.length > 0 && <span className="schip inventory">{held.length} in inventory</span>}
      <span className="schip">{unplaceable} unplaceable</span>
      <span className="schip">{lbs.toLocaleString()} lbs moved</span>
    </div>
  );
}

/* ------------------------------------------------------------- transcript */

function Transcript({ lines, humanLabel }: { lines: Line[]; humanLabel: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, lines[lines.length - 1]?.text]);
  if (lines.length === 0) return <div className="tx empty" ref={boxRef} />;
  return (
    <div className="tx" ref={boxRef}>
      {lines.map((l, i) => (
        <p key={i} className={l.speaker === 'agent' ? 'ln agent' : 'ln human'}>
          <span className="spk">{l.speaker === 'agent' ? 'Donna' : humanLabel}</span>
          {l.text}
        </p>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- live driver */

/**
 * Pick the donation the live driver renders (§J.2 / §J.5): the followed donation
 * (post-gate) if it is still present, else the newest in a live-active status.
 * Never throws — returns null when there is nothing live to show.
 */
function pickLiveDon(donations: Donation[], followId: string | null): Donation | null {
  if (followId) {
    const f = donations.find((d) => d.id === followId);
    if (f) return f;
  }
  const active = donations
    .filter((d) => d.status === 'awaiting_triage' || d.status === 'dispatching')
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  return active[0] ?? null;
}

/** Cheap signature of the routing-relevant shape, so the bus effect only refires on change. */
function liveSignature(d: Donation): string {
  const legs = d.items.map((i) => `${i.id}:${i.status}:${i.attempts.map((a) => `${a.recipientId}/${a.outcome}`).join(',')}`).join('|');
  return `${d.id}:${d.status}:${d.pickupLat ?? ''},${d.pickupLng ?? ''}:${legs}`;
}

/**
 * Recompute the whole map narrative from a live donation — same visuals as the
 * replay driver: direct arc or store legs per routeVia on accepted items, and
 * failedAtPickup on any item that ended unplaceable.
 */
function busFromLiveDonation(don: Donation, recipsById: Record<string, Recipient>): Partial<DemoBus> {
  const pickupPt: [number, number] | null =
    don.pickupLat != null && don.pickupLng != null ? [don.pickupLat, don.pickupLng] : null;
  const routes: DemoRoute[] = [];
  const focus: string[] = [];
  let failed = false;
  let held = false;
  for (const item of don.items) {
    // §K.1 — held item: pickup→food-bank leg, then it rests as a teal pulse at the
    // food bank. No outbound call, so nothing to focus.
    if (item.status === 'held') {
      held = true;
      if (pickupPt) routes.push({ id: `${item.id}-hold`, kind: 'store-leg1', from: pickupPt, to: FB });
      continue;
    }
    for (const a of item.attempts) if (!focus.includes(a.recipientId)) focus.push(a.recipientId);
    const acc = item.attempts.find((a) => a.outcome === 'accepted');
    if (acc) {
      const rec = recipsById[acc.recipientId];
      const recPt: [number, number] | null = rec ? [rec.lat, rec.lng] : null;
      if (routeVia(item.hoursToSpoil) === 'store' && pickupPt && recPt) {
        routes.push({ id: `${item.id}-l1`, kind: 'store-leg1', from: pickupPt, to: FB });
        routes.push({ id: `${item.id}-l2`, kind: 'store-leg2', from: FB, to: recPt });
      } else if (pickupPt && recPt) {
        routes.push({ id: `${item.id}-d`, kind: 'direct', from: pickupPt, to: recPt });
      }
    } else if (item.status === 'unplaceable') {
      failed = true;
    }
  }
  return {
    active: true,
    pickup: pickupPt ? { lat: don.pickupLat as number, lng: don.pickupLng as number, label: don.donorName ?? 'Pickup' } : undefined,
    routes,
    focusRecipientIds: focus,
    failedAtPickup: failed,
    heldAtFoodBank: held,
  };
}

// A synthetic donation shell for the pre-triage inbound panel: a caller is on the
// line but no donation record exists yet (it appears only after hangup).
const INBOUND_CALLER: Donation = {
  id: 'live-inbound', sourceChannel: 'voice', sourceContact: 'inbound caller',
  receivedAt: new Date(0).toISOString(), rawText: '', status: 'received', items: [],
  donorName: 'Inbound caller',
};

/**
 * Build the Outbound panel view for a live dispatching donation: the `.dialing`
 * item (elapsed timer + streaming captions) if one is ringing, else the most
 * recent landed attempt with its outcome (between-call state).
 */
function liveCallView(don: Donation, captions: Line[], now: number): CallView | null {
  const dialingItem = don.items.find((i) => i.dialing);
  if (dialingItem && dialingItem.dialing) {
    return {
      recipientName: dialingItem.dialing.recipientName,
      itemName: dialingItem.item,
      lines: captions,
      n: captions.length,
      elapsedMs: now - Date.parse(dialingItem.dialing.startedAt),
    };
  }
  const attempts = don.items.flatMap((i) => i.attempts.map((a) => ({ item: i.item, ...a })));
  const last = attempts[attempts.length - 1];
  if (last) {
    return {
      recipientName: last.recipientName, itemName: last.item,
      lines: last.transcript, n: last.transcript.length,
      outcome: last.outcome, reason: last.reason,
    };
  }
  return null;
}

/**
 * The LIVE render (§J.2). The SAME panels as the canned path, driven straight from
 * the poll — the phone call is the pacing. `donation` is null pre-triage (caller
 * on the line, captions only); it pops at awaiting_triage after hangup.
 */
function LiveStage({
  donation, captions, now, recipsById, onApprove, onReset, err,
}: {
  donation: Donation | null;
  captions: Line[];
  now: number;
  recipsById: Record<string, Recipient>;
  onApprove: (id: string) => void;
  onReset: () => void;
  err: string | null;
}) {
  const phase: 'inbound' | 'gate' | 'calling' | 'done' =
    !donation ? 'inbound'
      : donation.status === 'awaiting_triage' ? 'gate'
        : donation.status === 'resolved' ? 'done'
          : 'calling'; // dispatching (or a transient status while following a handoff)

  const inboundDon = donation ?? INBOUND_CALLER;
  // Pre-triage streams captions; once the donation exists the parsed transcript is
  // authoritative (backend clears live lines after the end-of-call report).
  const inboundLines = donation ? parseRaw(donation.rawText) : captions;

  const call = phase === 'calling' && donation ? liveCallView(donation, captions, now) : null;
  const draftMsg = donation?.donorMessage?.trim() ?? '';
  const showDraft = phase === 'done' && draftMsg !== '' && !/^dispatch failed/i.test(draftMsg);

  const phaseName =
    phase === 'inbound' ? 'Inbound call'
      : phase === 'gate' ? 'Human gate'
        : phase === 'done' ? 'Dispatch complete'
          : 'Calling recipients';

  // §L.1 — the rail on the live path. A real call has no transcription or
  // intelligence beat to observe (the work happens server-side between hangup
  // and awaiting_triage), so those capsules are simply already done by the time
  // a donation exists. Never fake a spinner over work that has already finished.
  const railIdx = phase === 'inbound' ? 0
    : phase === 'gate' ? 4
      : phase === 'calling' ? 5
        : RAIL.length;

  return (
    <div className="stage">
      <PipelineRail index={railIdx} />

      <InboundPanel donation={inboundDon} lines={inboundLines} />

      {call && <OutboundCallPanel call={call} />}
      {showDraft && donation && (
        <DraftPanel donation={donation} draft={{ done: true, text: draftMsg, error: false }} />
      )}

      <div className="stage-strip">
        <div className="strip-phase display-face">{phaseName}</div>

        {donation && donation.items.length > 0 && (
          <div className="vstrip">
            {donation.items.map((it) => (
              <VerdictCard key={it.id} item={it} resolved={liveResolveItem(it)} />
            ))}
          </div>
        )}

        {phase === 'done' && donation && <SummaryChips donation={donation} />}

        <div className="stage-controls">
          {phase === 'inbound' && (
            <span className="muted">On the line — the caller is describing a donation.</span>
          )}
          {phase === 'gate' && donation && (
            <>
              <span className="muted">Real inbound call — held for review.</span>
              <button className="btn-primary" onClick={() => onApprove(donation.id)}>Approve &amp; dispatch</button>
            </>
          )}
          {phase === 'calling' && (
            <span className="muted">Dispatching — Donna is working the list.</span>
          )}
          {phase === 'done' && (
            <button className="btn-quiet" onClick={onReset}>Reset</button>
          )}
        </div>
      </div>

      {err && <div className="stage-err">backend: {err}</div>}
    </div>
  );
}
