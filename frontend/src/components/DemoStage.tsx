import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type {
  CallOutcome, Donation, DonationItem, EnrichedDonation, Recipient,
} from '../types';
import type { DemoRoute } from '../demoBus';
import { setDemoBus, resetDemoBus } from '../demoBus';
import { FOOD_BANK, routeVia, verdictCopy, humanize } from '../theme';
import { ChannelIcon, Phone, Mail, MessageSquare } from '../icons';

/**
 * The Demo tab (§I.4) — a choreographed stage that plays out OVER the visible
 * map. `.stage` is a transparent, pointer-events:none layer so the map pans
 * underneath; the panels here are opaque floating surfaces.
 *
 * How it moves: the backend is instant in sim mode (dispatch is synchronous,
 * /api/live is always empty), so ALL pacing is client-owned REPLAY. "Run demo"
 * pulls the canned scored donation; "Approve & dispatch" resolves it in one call
 * and we then re-enact the returned attempts item-by-item. The routing narrative
 * (direct vs via-warehouse) is presentation-only — the backend has no depot; see
 * theme.ts routeVia — and is written to the demo bus as phases progress.
 *
 * Deliberately self-contained (own polling, own state) rather than wired into
 * DonnaProvider: the map/console keeps working untouched, and a bug in here on
 * demo night can't take that down with it. The demo bus is the ONLY shared
 * surface with MapView; neither module imports the other.
 */

type Phase = 'idle' | 'inbound' | 'parsed' | 'gate' | 'calling' | 'callback' | 'done';
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
}
interface DraftView { done: boolean; text: string; error: boolean; }

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

  // Live-mode insurance (§I.4): a 1s self-contained poll. In sim mode /api/live
  // is always empty and canned lands at 'scored', so this stays dormant — it only
  // wakes for a REAL inbound VAPI call that lands at awaiting_triage.
  const [liveLines, setLiveLines] = useState<Line[]>([]);
  const [liveDon, setLiveDon] = useState<Donation | null>(null);
  const [approvedId, setApprovedId] = useState<string | null>(null);

  // Choreographer control: runIdRef invalidates a running replay on reset/unmount;
  // skipRef fast-forwards the current phase (every sleep resolves instantly).
  const runIdRef = useRef(0);
  const skipRef = useRef(false);

  const sleep = (ms: number): Promise<void> => new Promise((res) => {
    const t0 = performance.now();
    const step = () => {
      if (skipRef.current || performance.now() - t0 >= ms) { res(); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  useEffect(() => { void api.listRecipients().then((rs) => {
    const m: Record<string, Recipient> = {};
    for (const r of rs) m[r.id] = r;
    setRecipsById(m);
  }).catch(() => {}); }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const [lv, ds] = await Promise.all([api.live(), api.listDonations()]);
        if (!alive) return;
        setLiveLines(lv.calls?.[0]?.lines ?? []);
        const latest = [...(ds || [])].sort(
          (a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt),
        )[0] || null;
        setLiveDon(latest);
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
      setDemoBus({ active: true, pickup: { lat: d.pickupLat, lng: d.pickupLng, label: d.donorName ?? 'Pickup' }, routes: [], focusRecipientIds: [], failedAtPickup: false });
    } else {
      setDemoBus({ active: true, routes: [], focusRecipientIds: [], failedAtPickup: false });
    }
    setPhase('inbound');
    const lines = parseRaw(d.rawText);
    for (let i = 1; i <= lines.length; i++) {
      setInboundN(i); await sleep(550); if (runIdRef.current !== rid) return;
    }
    skipRef.current = false; // phase boundary — a Skip in 'inbound' must not bleed into 'parsed'
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
    const pickupPt: [number, number] | null =
      disp.pickupLat != null && disp.pickupLng != null ? [disp.pickupLat, disp.pickupLng] : null;
    const routes: DemoRoute[] = [];
    const focus: string[] = [];

    for (const item of disp.items) {
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
      setEnriched(enr); setDispatched(null); setStartedCanned(true);
      setInboundN(0); setItemsN(0); setCall(null); setDraft(null);
      void runAfterCanned(enr);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function approveDispatch() {
    if (!enriched) return;
    setErr(null);
    try {
      const disp = await api.dispatch(enriched.donation.id);
      setDispatched(disp);
      void runAfterDispatch(disp);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function resetStage() {
    runIdRef.current++;
    skipRef.current = false;
    resetDemoBus();
    setEnriched(null); setDispatched(null); setStartedCanned(false);
    setInboundN(0); setItemsN(0); setCall(null); setDraft(null);
    setApprovedId(null); setPhase('idle'); setErr(null);
    try { await api.reset(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  const skip = () => { skipRef.current = true; };

  /* ---------------- live mode (real inbound VAPI, dormant in sim) --------------- */
  const liveActive = !startedCanned && liveDon != null && (
    liveDon.status === 'awaiting_triage' || liveDon.status === 'dispatching'
    || (liveDon.status === 'resolved' && approvedId === liveDon.id)
  );

  useEffect(() => {
    if (!liveActive || !liveDon) return;
    if (liveDon.pickupLat != null && liveDon.pickupLng != null) {
      setDemoBus({ active: true, pickup: { lat: liveDon.pickupLat, lng: liveDon.pickupLng, label: liveDon.donorName ?? 'Pickup' } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveActive, liveDon?.id]);

  async function approveLive(id: string) {
    setApprovedId(id);
    try { await api.approve(id); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  if (liveActive && liveDon) {
    return <LiveStage donation={liveDon} liveLines={liveLines} onApprove={approveLive} err={err} />;
  }

  /* ---------------- canned choreography render ---------------- */
  const donation = dispatched ?? enriched?.donation ?? null;
  const items = donation?.items ?? [];
  const inboundLines = liveLines.length
    ? liveLines
    : parseRaw(enriched?.donation.rawText).slice(0, inboundN);
  const showInbound = phase !== 'idle' && donation != null;
  const visibleItems = phase === 'inbound' ? 0 : phase === 'parsed' ? itemsN : items.length;
  const animating = phase === 'inbound' || phase === 'parsed' || phase === 'calling' || phase === 'callback';

  return (
    <div className="stage">
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
            {items.slice(0, visibleItems).map((it) => (
              <VerdictCard key={it.id} item={it} resolved={dispatched ? resolveItem(it) : null} />
            ))}
          </div>
        )}

        {phase === 'done' && dispatched && <SummaryChips donation={dispatched} />}

        <div className="stage-controls">
          {phase === 'idle' && (
            <>
              <span className="muted">Play the inbound call, the routing verdict, the human gate, and Donna working the phones.</span>
              <button className="btn-primary" onClick={() => void runDemo()}>Run demo</button>
            </>
          )}
          {phase === 'gate' && (
            <>
              <span className="muted">Held for review — nothing is called until you approve.</span>
              <button className="btn-primary" onClick={() => void approveDispatch()}>Approve &amp; dispatch</button>
            </>
          )}
          {phase === 'done' && (
            <button className="btn-primary" onClick={() => void resetStage()}>Reset</button>
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
    case 'parsed': return 'Routing verdict';
    case 'gate': return 'Human gate';
    case 'calling': return 'Calling recipients';
    case 'callback': return 'Drafting callback';
    case 'done': return 'Dispatch complete';
    default: return '';
  }
}

/** Accepted → placed at recipient; otherwise no takers. */
function resolveItem(it: DonationItem): { ok: boolean; recipientName?: string } {
  const acc = it.attempts.find((a) => a.outcome === 'accepted');
  if (acc || it.status === 'matched') return { ok: true, recipientName: acc?.recipientName };
  return { ok: false };
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
        {!call.outcome && <span className="sp-live">On call</span>}
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

function VerdictCard({ item, resolved }: { item: DonationItem; resolved: { ok: boolean; recipientName?: string } | null }) {
  const via = routeVia(item.hoursToSpoil);
  return (
    <div className="vcard">
      <div className="vc-top">
        <span className="vc-name">{item.item}</span>
        <span className="vc-qty">{item.qtyLbs.toLocaleString()} lbs</span>
      </div>
      <div className="vc-mid">
        <span className={`vc-verdict ${via}`}>{via === 'store' ? 'STORE' : 'DIRECT'}</span>
        {resolved && (
          <span className={`status-tag ${resolved.ok ? 'placed' : 'unplaceable'}`}>
            {resolved.ok ? 'PLACED' : 'NO TAKERS'}
          </span>
        )}
      </div>
      <div className="vc-copy">{verdictCopy(item)}</div>
      {resolved?.ok && resolved.recipientName && <div className="vc-dest">→ {resolved.recipientName}</div>}
    </div>
  );
}

/* -------------------------------------------------------- summary chips */

function SummaryChips({ donation }: { donation: Donation }) {
  const placed = donation.items.filter((i) => i.attempts.some((a) => a.outcome === 'accepted') || i.status === 'matched');
  const unplaceable = donation.items.length - placed.length;
  const lbs = placed.reduce((s, i) => s + i.qtyLbs, 0);
  return (
    <div className="summary-chips">
      <span className="schip">{placed.length} placed</span>
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

/* ---------------------------------------------------------------- live mode */

// Real inbound (awaiting_triage → resolved) rendered straight from the poll, no
// client pacing — the backend drives the timeline for actual VAPI calls.
function LiveStage({
  donation, liveLines, onApprove, err,
}: {
  donation: Donation; liveLines: Line[];
  onApprove: (id: string) => void; err: string | null;
}) {
  const held = donation.status === 'awaiting_triage';
  const attempts = donation.items.flatMap((i) => i.attempts.map((a) => ({ item: i.item, ...a })));
  const last = attempts[attempts.length - 1];
  const inboundLines = held && liveLines.length ? liveLines : parseRaw(donation.rawText);
  return (
    <div className="stage">
      <InboundPanel donation={donation} lines={inboundLines} />

      {last && (
        <OutboundCallPanel call={{ recipientName: last.recipientName, itemName: last.item, lines: last.transcript, n: last.transcript.length, outcome: last.outcome, reason: last.reason }} />
      )}
      {donation.status === 'resolved' && donation.donorMessage && !/^dispatch failed/i.test(donation.donorMessage.trim()) && (
        <DraftPanel donation={donation} draft={{ done: true, text: donation.donorMessage, error: false }} />
      )}

      <div className="stage-strip">
        <div className="strip-phase display-face">
          {held ? 'Human gate' : donation.status === 'resolved' ? 'Dispatch complete' : 'Calling recipients'}
        </div>
        <div className="vstrip">
          {donation.items.map((it) => (
            <VerdictCard key={it.id} item={it} resolved={donation.status === 'resolved' ? resolveItem(it) : null} />
          ))}
        </div>
        <div className="stage-controls">
          {held && (
            <>
              <span className="muted">Real inbound call — held for review.</span>
              <button className="btn-primary" onClick={() => onApprove(donation.id)}>Approve &amp; dispatch</button>
            </>
          )}
          {donation.status === 'dispatching' && <span className="muted">Dispatching — Donna is working the list.</span>}
          {donation.status === 'resolved' && <span className="muted">Resolved.</span>}
        </div>
      </div>

      {err && <div className="stage-err">backend: {err}</div>}
    </div>
  );
}
