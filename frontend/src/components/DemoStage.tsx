import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Donation, DonationItem, LiveCall } from '../types';

/**
 * The stage dashboard — the demo narrative on one screen, no navigation, because
 * the presenter is holding a phone in one hand.
 *
 * Reads left→right: the donor's inbound call and what Donna heard, the items the
 * parser pulled out, the human gate, then the outbound call to the pantry the
 * scoring engine chose and how it answered.
 *
 * Deliberately self-contained (own polling, own state) rather than wired into
 * DonnaProvider: the map/equity console keeps working untouched, and a bug in
 * here on demo night can't take that down with it.
 */

const POLL_MS = 1000;

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function DemoStage(): React.JSX.Element {
  const [donations, setDonations] = useState<Donation[]>([]);
  const [live, setLive] = useState<LiveCall[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const now = useNow(500);

  const poll = useCallback(async () => {
    try {
      const [ds, lv] = await Promise.all([api.listDonations(), api.live()]);
      setDonations(Array.isArray(ds) ? ds : []);
      setLive(lv.calls ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = window.setInterval(() => { void poll(); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [poll]);

  // Newest donation is the one on stage.
  const donation = [...donations].sort(
    (a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt),
  )[0];

  const dialingItem = donation?.items.find((i) => i.dialing);
  const inboundLive = !donation || donation.status === 'awaiting_triage';
  // One call is in flight at a time, so the live buffer maps to whichever phase
  // we are in: the donor's call before triage, the pantry's call after.
  const liveLines = live[0]?.lines ?? [];

  async function approve(id: string) {
    setApproving(id);
    try {
      await api.approve(id);
      await poll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(null);
    }
  }

  return (
    <div className="stage">
      <div className="stage-grid">
        <InboundCard
          donation={donation}
          lines={inboundLive ? liveLines : []}
          ringing={inboundLive && liveLines.length > 0}
        />

        <InventoryCard donation={donation} />

        <DecisionCard
          donation={donation}
          onApprove={approve}
          approving={approving}
        />

        <OutboundCard
          item={dialingItem}
          lines={!inboundLive ? liveLines : []}
          now={now}
        />

        <ResultCard donation={donation} />
      </div>

      {err && <div className="stage-err">backend: {err}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- inbound */

function InboundCard({
  donation, lines, ringing,
}: {
  donation?: Donation;
  lines: { speaker: string; text: string }[];
  ringing: boolean;
}) {
  const waiting = !donation && lines.length === 0;
  return (
    <section className={`scard inbound${ringing ? ' hot' : ''}`}>
      <h3>
        Inbound — donor calling
        {ringing && <span className="live-tag">On call</span>}
      </h3>

      {waiting && <p className="muted">Waiting for a call…</p>}

      {ringing && <p className="callee">On the line now</p>}

      {!ringing && donation && (
        <p className="callee">
          {donation.donorName ?? 'Donor'} · {donation.sourceContact}
          {donation.pickupLocation ? ` · pickup ${donation.pickupLocation}` : ''}
        </p>
      )}

      <Transcript
        lines={lines.length ? lines : parseRaw(donation?.rawText)}
        donorSide
      />
    </section>
  );
}

/** The stored rawText is the finished dialogue — render it once the call ends. */
function parseRaw(raw?: string): { speaker: string; text: string }[] {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(ai|user)\s*:\s*(.*)$/i.exec(l);
      if (!m) return { speaker: 'agent', text: l };
      return { speaker: m[1].toLowerCase() === 'ai' ? 'agent' : 'recipient', text: m[2] };
    });
}

/* -------------------------------------------------------------- inventory */

function InventoryCard({ donation }: { donation?: Donation }) {
  return (
    <section className="scard">
      <h3>Inventory — what Donna heard</h3>
      {!donation && <p className="muted">Nothing yet.</p>}
      {donation && (
        <ul className="items">
          {donation.items.map((i) => (
            <li key={i.id} className={`item ${i.status}`}>
              <div className="item-top">
                <strong>{i.item}</strong>
                <span className="qty">{i.qtyLbs} lbs</span>
              </div>
              <div className="item-meta">
                {humanCat(i.category)} · spoils in {i.hoursToSpoil}h
                {i.needsRefrigeration ? ' · needs cold' : ''}
              </div>
              <ItemStatusChip item={i} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ItemStatusChip({ item }: { item: DonationItem }) {
  if (item.dialing) return <span className="chip calling">calling {item.dialing.recipientName}…</span>;
  if (item.status === 'matched') return <span className="chip ok">{item.resolutionReason}</span>;
  if (item.status === 'unplaceable') return <span className="chip bad">{item.resolutionReason}</span>;
  return <span className="chip">pending</span>;
}

/* --------------------------------------------------------------- decision */

function DecisionCard({
  donation, onApprove, approving,
}: {
  donation?: Donation;
  onApprove: (id: string) => void;
  approving: string | null;
}) {
  const held = donation?.status === 'awaiting_triage';
  const running = donation?.status === 'dispatching';

  return (
    <section className={`scard decision${held ? ' hot' : ''}`}>
      <h3>Human decision</h3>

      {!donation && <p className="muted">—</p>}

      {held && (
        <>
          <p className="hold">
            Held for review. Nothing is called until you say so.
          </p>
          <button
            className="approve"
            disabled={approving === donation.id}
            onClick={() => onApprove(donation.id)}
          >
            {approving === donation.id ? 'Starting…' : 'Call the pantries →'}
          </button>
        </>
      )}

      {running && <p className="muted">Dispatching — Donna is working the list.</p>}
      {donation?.status === 'resolved' && <p className="muted">Done.</p>}
    </section>
  );
}

/* --------------------------------------------------------------- outbound */

function OutboundCard({
  item, lines, now,
}: {
  item?: DonationItem;
  lines: { speaker: string; text: string }[];
  now: number;
}) {
  const dialing = item?.dialing;
  const secs = dialing ? Math.max(0, Math.round((now - Date.parse(dialing.startedAt)) / 1000)) : 0;

  return (
    <section className={`scard outbound${dialing ? ' hot' : ''}`}>
      <h3>
        Outbound — Donna calling a pantry
        {dialing && <span className="live-tag">On call</span>}
      </h3>

      {!dialing && <p className="muted">No call in flight.</p>}

      {dialing && (
        <p className="callee">
          {dialing.recipientName} · {secs}s
          {item ? <span className="about"> — about {item.item}</span> : null}
        </p>
      )}

      <Transcript lines={lines} />
    </section>
  );
}

/* ----------------------------------------------------------------- result */

function ResultCard({ donation }: { donation?: Donation }) {
  const attempts = (donation?.items ?? []).flatMap((i) =>
    i.attempts.map((a) => ({ item: i.item, ...a })),
  );

  return (
    <section className="scard result">
      <h3>Outcomes</h3>
      {attempts.length === 0 && <p className="muted">No calls yet.</p>}
      <ul className="attempts">
        {attempts.map((a, n) => (
          <li key={n} className={a.outcome}>
            <span className="who">{a.recipientName}</span>
            <span className={`chip ${a.outcome === 'accepted' ? 'ok' : 'bad'}`}>{a.outcome}</span>
            <span className="about">{a.item}</span>
            {a.reason && <span className="why">“{a.reason}”</span>}
          </li>
        ))}
      </ul>
      {donation?.donorMessage && (
        <div className="donor-msg">
          <span className="lbl">Donor callback</span>
          <p>{donation.donorMessage}</p>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------- transcript */

function Transcript({
  lines, donorSide,
}: {
  lines: { speaker: string; text: string }[];
  donorSide?: boolean;
}) {
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
          <span className="spk">{l.speaker === 'agent' ? 'Donna' : donorSide ? 'Donor' : 'Pantry'}</span>
          {l.text}
        </p>
      ))}
    </div>
  );
}

function humanCat(c: string): string {
  return c.replace(/_/g, ' ');
}
