import React, { useMemo, useState } from 'react';
import { useDonna } from '../state';
import type { CallLogEntry, CallOutcome, Donation, DonationItem, Recipient } from '../types';
import { humanize } from '../theme';

// §G.2 — Outbound · Network. The right dock's default view is a DIRECTORY of every
// recipient with a phone number on file (GET /api/recipients). The chronological
// outbound feed is gone; per-recipient call history covers it. Everything renders
// from fetched DB state (recipients + the flattened /api/calls log + donations for
// the pending-item pickers). Sort: most-recently-called first, then alphabetical.

interface RecipientInfo {
  calls: CallLogEntry[];          // this recipient's calls, newest first
  lastAt: string | null;
  lastOutcome: CallOutcome | null;
  acceptedItems: string[];        // unique item names this place agreed to take
}

const TYPE_GLYPH: Record<Recipient['type'], string> = {
  pantry: '🛒',
  community_agency: '🤝',
};

function outcomeDot(o: CallOutcome | null): string {
  if (o === 'accepted') return 'ok';
  if (o === 'declined') return 'bad';
  if (o === 'no_answer') return 'warn';
  return 'never';                 // never-called → grey
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function callKey(c: { itemId: string; recipientId: string; at: string }): string {
  return `${c.itemId}:${c.recipientId}:${c.at}`;
}

export function NetworkPanel() {
  const { recipients, calls, donations } = useDonna();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedCallKey, setExpandedCallKey] = useState<string | null>(null);
  const [modal, setModal] = useState<{ kind: 'call' | 'manual'; recipient: Recipient } | null>(null);

  // Per-recipient rollup derived from the newest-first global call log.
  const infoById = useMemo<Record<string, RecipientInfo>>(() => {
    const m: Record<string, RecipientInfo> = {};
    for (const r of recipients) m[r.id] = { calls: [], lastAt: null, lastOutcome: null, acceptedItems: [] };
    for (const c of calls) {
      const info = m[c.recipientId];
      if (!info) continue;
      info.calls.push(c);
      if (!info.lastAt) { info.lastAt = c.at; info.lastOutcome = c.outcome; } // first = newest
      if (c.outcome === 'accepted') {
        const name = humanize(c.itemName);
        if (!info.acceptedItems.includes(name)) info.acceptedItems.push(name);
      }
    }
    return m;
  }, [recipients, calls]);

  // Sort: most-recently-called first, then never-called alphabetical (§G.2).
  const sorted = useMemo(() => {
    return [...recipients].sort((a, b) => {
      const la = infoById[a.id]?.lastAt;
      const lb = infoById[b.id]?.lastAt;
      if (la && lb) return la < lb ? 1 : la > lb ? -1 : a.name.localeCompare(b.name);
      if (la) return -1;
      if (lb) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [recipients, infoById]);

  // Every pending item across all donations — the pool both modals pick from.
  const pendingItems = useMemo<Array<{ it: DonationItem; donation: Donation }>>(() => {
    const out: Array<{ it: DonationItem; donation: Donation }> = [];
    for (const d of donations) {
      for (const it of d.items) if (it.status === 'pending') out.push({ it, donation: d });
    }
    return out;
  }, [donations]);

  const toggleRow = (id: string) => {
    setExpandedId((cur) => (cur === id ? null : id));
    setExpandedCallKey(null);
  };

  return (
    <aside className="network">
      <div className="panel-head">
        <span className="panel-title">Network</span>
        <span className="panel-sub">Outbound</span>
        {recipients.length > 0 && <span className="panel-count">{recipients.length}</span>}
      </div>

      <div className="net-scroll">
        {sorted.length === 0 ? (
          <div className="panel-empty">No recipients on file.</div>
        ) : (
          sorted.map((r) => (
            <RecipientRow
              key={r.id}
              r={r}
              info={infoById[r.id]}
              expanded={expandedId === r.id}
              expandedCallKey={expandedCallKey}
              onToggle={() => toggleRow(r.id)}
              onToggleCall={(k) => setExpandedCallKey((cur) => (cur === k ? null : k))}
              onDonnaCall={() => setModal({ kind: 'call', recipient: r })}
              onManualCall={() => setModal({ kind: 'manual', recipient: r })}
            />
          ))
        )}
      </div>

      {modal?.kind === 'call' && (
        <DonnaCallModal
          recipient={modal.recipient}
          pending={pendingItems}
          onClose={() => setModal(null)}
          onPlaced={(recipientId, atKey) => { setExpandedId(recipientId); setExpandedCallKey(atKey); setModal(null); }}
        />
      )}
      {modal?.kind === 'manual' && (
        <ManualCallModal
          recipient={modal.recipient}
          pending={pendingItems}
          onClose={() => setModal(null)}
          onLogged={(recipientId, atKey) => { setExpandedId(recipientId); setExpandedCallKey(atKey); setModal(null); }}
        />
      )}
    </aside>
  );
}

// ---- recipient row ----------------------------------------------------------

function RecipientRow({ r, info, expanded, expandedCallKey, onToggle, onToggleCall, onDonnaCall, onManualCall }: {
  r: Recipient; info: RecipientInfo | undefined; expanded: boolean;
  expandedCallKey: string | null; onToggle: () => void; onToggleCall: (k: string) => void;
  onDonnaCall: () => void; onManualCall: () => void;
}) {
  const dot = outcomeDot(info?.lastOutcome ?? null);
  const accepted = info?.acceptedItems ?? [];
  const history = info?.calls ?? [];

  return (
    <div className={`net-row${expanded ? ' open' : ''}`}>
      <button className="net-line" onClick={onToggle} aria-expanded={expanded}>
        <span className="net-l1">
          <span className={`sdot ${dot}`} />
          <span className="net-name">{r.name}</span>
          <span className="net-glyph" title={humanize(r.type)}>{TYPE_GLYPH[r.type]}</span>
          {info?.lastAt && <span className="net-lastcall">{fmtTime(info.lastAt)}</span>}
        </span>
        <span className="net-l2">
          {accepted.length > 0 ? (
            <span className="net-chips">
              {accepted.slice(0, 4).map((n) => <span className="net-chip" key={n}>{n}</span>)}
              {accepted.length > 4 && <span className="net-chip more">+{accepted.length - 4}</span>}
            </span>
          ) : (
            <span className="net-phone">{r.phone}</span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="net-exp">
          <div className="net-facts">
            <span className="nf-contact">{r.leadContact}</span>
            <span className="nf-dot">·</span>
            <span className="nf-phone">{r.phone}</span>
            {r.bestCallWindow && <><span className="nf-dot">·</span><span className="nf-window">{r.bestCallWindow}</span></>}
          </div>

          {history.length > 0 ? (
            <div className="net-history">
              {history.map((c) => {
                const k = callKey(c);
                return (
                  <CallHistoryLine
                    key={k}
                    c={c}
                    open={expandedCallKey === k}
                    onToggle={() => onToggleCall(k)}
                  />
                );
              })}
            </div>
          ) : (
            <div className="net-nohist">No calls yet.</div>
          )}

          <div className="net-actions">
            <button className="btn hot sm" onClick={onDonnaCall}>☎ Donna, call</button>
            <button className="btn sm" onClick={onManualCall}>👤 Log manual call</button>
          </div>
        </div>
      )}
    </div>
  );
}

function CallTag({ c }: { c: CallLogEntry }) {
  if (c.manual) return <span className="ctag manual" title="Human-logged call">👤</span>;
  if (c.simulated) return <span className="ctag sim" title="Simulated call">SIM</span>;
  return null;
}

function CallHistoryLine({ c, open, onToggle }: { c: CallLogEntry; open: boolean; onToggle: () => void }) {
  const glyph = c.outcome === 'accepted' ? '✓' : c.outcome === 'declined' ? '✗' : '…';
  const tail = c.outcome === 'accepted' ? 'accepted' : (c.reason || humanize(c.outcome));
  return (
    <div className={`chl ${c.outcome}${open ? ' open' : ''}`}>
      <button className="chl-line" onClick={onToggle}>
        <span className="chl-glyph">{glyph}</span>
        <span className="chl-item">{humanize(c.itemName)}</span>
        <CallTag c={c} />
        <span className="chl-time">{fmtTime(c.at)}</span>
        <span className="chl-tail">{tail}</span>
      </button>
      {open && (
        <div className="att-transcript">
          {c.transcript.length === 0 ? (
            <div className="chl-empty">No transcript recorded.</div>
          ) : (
            c.transcript.map((t, i) => (
              <div key={i} className={`bubble ${t.speaker}`}>{t.text}</div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---- pending-item picker (shared by both modals) ----------------------------

function PendingPicker({ pending, value, onChange }: {
  pending: Array<{ it: DonationItem; donation: Donation }>;
  value: string; onChange: (id: string) => void;
}) {
  return (
    <div className="pick-list">
      {pending.map(({ it, donation }) => (
        <label className={`pick${value === it.id ? ' on' : ''}`} key={it.id}>
          <input type="radio" name="pick-item" checked={value === it.id} onChange={() => onChange(it.id)} />
          <span className="pick-name">{humanize(it.item)}</span>
          <span className="pick-meta">{Math.round(it.qtyLbs).toLocaleString()} lb · {donation.donorName || 'donor'}</span>
        </label>
      ))}
    </div>
  );
}

// ---- "Donna, call" modal ----------------------------------------------------

function DonnaCallModal({ recipient, pending, onClose, onPlaced }: {
  recipient: Recipient; pending: Array<{ it: DonationItem; donation: Donation }>;
  onClose: () => void; onPlaced: (recipientId: string, atKey: string) => void;
}) {
  const { callRecipient } = useDonna();
  const [itemId, setItemId] = useState<string>(pending[0]?.it.id ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!itemId || busy) return;
    setBusy(true);
    try {
      const attempt = await callRecipient(itemId, recipient.id);
      onPlaced(recipient.id, callKey({ itemId, recipientId: recipient.id, at: attempt.at }));
    } catch { /* toast already surfaced; keep modal open */ }
    finally { setBusy(false); }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Call {recipient.name}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {pending.length === 0 ? (
          <p>No pending items to offer — everything is already placed or closed.</p>
        ) : (
          <>
            <p className="modal-hint">Donna will place a directed call offering one pending item to {recipient.leadContact}.</p>
            <PendingPicker pending={pending} value={itemId} onChange={setItemId} />
          </>
        )}
        <div className="modal-actions">
          <button className="link-btn" onClick={onClose}>Cancel</button>
          <button className="btn hot" onClick={submit} disabled={!itemId || busy}>
            {busy ? <span className="loading-line"><span className="spinner" /> Calling…</span> : '☎ Place call'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- "Log manual call" modal ------------------------------------------------

const OUTCOMES: Array<{ id: CallOutcome; lbl: string }> = [
  { id: 'accepted', lbl: 'Accepted' },
  { id: 'declined', lbl: 'Declined' },
  { id: 'no_answer', lbl: 'No answer' },
];

function ManualCallModal({ recipient, pending, onClose, onLogged }: {
  recipient: Recipient; pending: Array<{ it: DonationItem; donation: Donation }>;
  onClose: () => void; onLogged: (recipientId: string, atKey: string) => void;
}) {
  const { logManualCall } = useDonna();
  const [itemId, setItemId] = useState<string>(pending[0]?.it.id ?? '');
  const [outcome, setOutcome] = useState<CallOutcome>('accepted');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!itemId || busy) return;
    setBusy(true);
    try {
      const attempt = await logManualCall(itemId, recipient.id, {
        outcome,
        reason: reason.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      onLogged(recipient.id, callKey({ itemId, recipientId: recipient.id, at: attempt.at }));
    } catch { /* toast already surfaced; keep modal open */ }
    finally { setBusy(false); }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Log manual call · {recipient.name}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {pending.length === 0 ? (
          <p>No pending items to log against — everything is already placed or closed.</p>
        ) : (
          <>
            <p className="modal-hint">Record a call you made yourself. It lands in the log like an agent call, flagged 👤.</p>
            <div className="field-label">Item</div>
            <PendingPicker pending={pending} value={itemId} onChange={setItemId} />

            <div className="field-label">Outcome</div>
            <div className="seg-pick">
              {OUTCOMES.map((o) => (
                <button
                  key={o.id}
                  className={`seg-opt ${o.id}${outcome === o.id ? ' on' : ''}`}
                  onClick={() => setOutcome(o.id)}
                >{o.lbl}</button>
              ))}
            </div>

            {outcome === 'declined' && (
              <>
                <div className="field-label">Reason <span className="opt">optional</span></div>
                <input
                  className="text-in"
                  placeholder="e.g. still overstocked on produce"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </>
            )}

            <div className="field-label">Notes <span className="opt">optional</span></div>
            <textarea
              className="text-in area"
              placeholder="Anything worth remembering from the call…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </>
        )}
        <div className="modal-actions">
          <button className="link-btn" onClick={onClose}>Cancel</button>
          <button className="btn hot" onClick={submit} disabled={!itemId || busy}>
            {busy ? <span className="loading-line"><span className="spinner" /> Logging…</span> : 'Log call'}
          </button>
        </div>
      </div>
    </div>
  );
}
