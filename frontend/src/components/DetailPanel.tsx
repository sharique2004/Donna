import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDonna } from '../state';
import type { CallAttempt, DonationItem, RankedRecipient, Weights } from '../types';
import { TERM_KEYS } from '../types';
import { TERM_LABELS, HARDFAIL_LABELS, fmtHours, humanize } from '../theme';

export function DetailPanel() {
  const {
    current, activeRankings, activeExplanation, selectedItemId,
    config, rerank, dispatch, busy, closeDetail,
  } = useDonna();

  const donation = current?.donation ?? null;
  const item = useMemo<DonationItem | null>(
    () => donation?.items.find((i) => i.id === selectedItemId) ?? null,
    [donation, selectedItemId],
  );

  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [showFails, setShowFails] = useState(false);
  const [showTune, setShowTune] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // weight sliders (debounced live re-rank)
  const [weights, setWeights] = useState<Weights | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { if (config && !weights) setWeights(config.weights); }, [config, weights]);

  // reset transient UI when the selected item changes
  useEffect(() => { setExpandedRow(null); setShowFails(false); }, [selectedItemId]);

  const onSlide = (k: keyof Weights, v: number) => {
    if (!weights || !selectedItemId) return;
    const next = { ...weights, [k]: v };
    setWeights(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => rerank(selectedItemId, next), 220);
  };
  const resetWeights = () => {
    if (!config || !selectedItemId) return;
    setWeights(config.weights);
    rerank(selectedItemId, config.weights);
  };

  const feasible = useMemo(() => activeRankings.filter((r) => !r.score.hardFail).slice(0, 5), [activeRankings]);
  const fails = useMemo(() => activeRankings.filter((r) => r.score.hardFail), [activeRankings]);

  if (!item) return null;

  const resolved = donation?.status === 'resolved';
  const canDispatch = !!donation && donation.items.some((i) => i.status === 'pending') && !resolved;
  const onDispatchClick = () => {
    if (config && !config.autopilot) setShowConfirm(true);
    else void dispatch();
  };

  const attempts = item.attempts ?? [];

  return (
    <aside className="detail">
      <div className="detail-scroll">
        {/* §G — back control returns the right dock to the Network directory (as ✕) */}
        <button className="ob-back" onClick={closeDetail}>← Network</button>

        {/* 1 — item strip */}
        <div className="istrip">
          <span className={`sdot ${statusClass(item)}`} />
          <span className="iname">{item.item}</span>
          <span className="imeta">
            {Math.round(item.qtyLbs).toLocaleString()} lb
            {item.needsRefrigeration ? ' · ❄' : ''} · spoils in {Math.round(item.hoursToSpoil)}h
          </span>
          <button className="icon-btn close" onClick={closeDetail} aria-label="Close detail">✕</button>
        </div>

        {/* 2 — ranked matches */}
        {feasible.length === 0 && fails.length === 0 ? (
          <div className="detail-empty">No ranking yet.</div>
        ) : (
          <div className="ranks">
            {feasible.map((r, i) => (
              <RankRow
                key={r.recipient.id}
                r={r}
                idx={i}
                matched={item.matchedRecipientId === r.recipient.id}
                expanded={expandedRow === r.recipient.id}
                why={i === 0 && activeExplanation ? activeExplanation : deriveWhy(r, item)}
                onToggle={() => setExpandedRow((cur) => (cur === r.recipient.id ? null : r.recipient.id))}
              />
            ))}

            {fails.length > 0 && (
              <div className="fails">
                <button className="fails-toggle" onClick={() => setShowFails((s) => !s)}>
                  {fails.length} not feasible {showFails ? '▾' : '▸'}
                </button>
                {showFails && fails.map((r) => (
                  <div className="fail-row" key={r.recipient.id}>
                    <span className="fname">{r.recipient.name}</span>
                    <span className="freason">{HARDFAIL_LABELS[r.score.hardFail!] ?? 'not feasible'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 3 — tune (hidden behind ⚙) */}
        {weights && (
          <div className="tune">
            <button className="tune-toggle" onClick={() => setShowTune((s) => !s)} aria-expanded={showTune}>
              <span className="gear">⚙</span> Tune weights
            </button>
            {showTune && (
              <div className="sliders">
                {TERM_KEYS.map((k) => (
                  <div className="slider-row" key={k}>
                    <span className="sl-name">{TERM_LABELS[k]}</span>
                    <input
                      type="range" min={0} max={1} step={0.05}
                      value={weights[k]}
                      onChange={(e) => onSlide(k, parseFloat(e.target.value))}
                    />
                    <span className="sl-val">{weights[k].toFixed(2)}</span>
                  </div>
                ))}
                <button className="link-btn" onClick={resetWeights}>Reset to defaults</button>
              </div>
            )}
          </div>
        )}

        {/* 4 — dispatch */}
        {resolved ? (
          <button className="btn block" disabled>✓ Dispatched &amp; resolved</button>
        ) : (
          <button className="btn hot block" onClick={onDispatchClick} disabled={!canDispatch || busy.dispatch}>
            {busy.dispatch
              ? <span className="loading-line"><span className="spinner" /> Placing calls…</span>
              : (config && !config.autopilot ? 'Dispatch (confirm)' : 'Dispatch')}
          </button>
        )}

        {/* 5 — activity */}
        {attempts.length > 0 && (
          <div className="activity">
            {attempts.map((a, i) => <AttemptLine key={i} a={a} />)}
          </div>
        )}

        {donation?.donorMessage && (
          <DonorCallback name={firstName(donation.donorName)} text={donation.donorMessage} />
        )}
      </div>

      {showConfirm && donation && (
        <ConfirmModal
          count={donation.items.filter((i) => i.status === 'pending').length}
          onCancel={() => setShowConfirm(false)}
          onConfirm={() => { setShowConfirm(false); void dispatch(); }}
        />
      )}
    </aside>
  );
}

function statusClass(it: DonationItem): string {
  if (it.status === 'matched') return 'ok';
  if (it.status === 'unplaceable') return 'bad';
  return 'pending';
}

function RankRow({ r, idx, matched, expanded, why, onToggle }: {
  r: RankedRecipient; idx: number; matched: boolean; expanded: boolean;
  why: string; onToggle: () => void;
}) {
  const { selectRecipient } = useDonna();
  const s = r.score;
  return (
    <div className={`rrow${expanded ? ' open' : ''}${matched ? ' matched' : ''}`}>
      <button
        className="rrow-head"
        onClick={() => { onToggle(); selectRecipient(r.recipient.id); }}
      >
        <span className="rnum">#{idx + 1}</span>
        <span className="rname">{r.recipient.name}{matched ? ' ✓' : ''}</span>
        <span className="rscore">{s.total.toFixed(2)}</span>
      </button>
      <div className="rbar"><span className="rbar-fill" style={{ width: `${Math.round(s.total * 100)}%` }} /></div>

      {expanded && (
        <div className="rexp">
          <div className="microbars">
            {TERM_KEYS.map((k) => (
              <div className="micro" key={k}>
                <span className="mlabel">{TERM_LABELS[k]}</span>
                <span className="mtrack"><span className="mfill" style={{ width: `${Math.round(s[k] * 100)}%` }} /></span>
                <span className="mval">{s[k].toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div className="rexp-meta">{fmtHours(s.driveTimeHours)} drive · {s.distanceMiles.toFixed(1)} mi</div>
          <div className="rwhy">{why}</div>
        </div>
      )}
    </div>
  );
}

function AttemptLine({ a }: { a: CallAttempt }) {
  const [open, setOpen] = useState(false);
  const ok = a.outcome === 'accepted';
  const glyph = ok ? '✓' : a.outcome === 'declined' ? '✗' : '…';
  const tail = a.outcome === 'accepted' ? 'accepted' : (a.reason || humanize(a.outcome));
  return (
    <div className={`att ${a.outcome}${open ? ' open' : ''}`}>
      <button className="att-line" onClick={() => setOpen((o) => !o)}>
        <span className="aglyph">{glyph}</span>
        <span className="aname">{a.recipientName}</span>
        <span className="atail">— {tail}</span>
      </button>
      {open && (
        <div className="att-transcript">
          {a.transcript.map((t, i) => (
            <div key={i} className={`bubble ${t.speaker}`}>{t.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function DonorCallback({ name, text }: { name: string; text: string }) {
  const [more, setMore] = useState(false);
  return (
    <div className="callback">
      <div className="cb-to">To {name}:</div>
      <div className={`cb-bubble${more ? ' full' : ''}`}>{text}</div>
      <button className="link-btn cb-more" onClick={() => setMore((m) => !m)}>{more ? 'less' : 'more'}</button>
    </div>
  );
}

function ConfirmModal({ count, onCancel, onConfirm }: { count: number; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Dispatch {count} item{count === 1 ? '' : 's'}?</h3>
        </div>
        <p>Autopilot is off. Donna will place outbound calls to ranked recipients until each item is matched or exhausted.</p>
        <div className="modal-actions">
          <button className="link-btn" onClick={onCancel}>Cancel</button>
          <button className="btn hot" onClick={onConfirm}>Confirm dispatch</button>
        </div>
      </div>
    </div>
  );
}

function deriveWhy(r: RankedRecipient, item: DonationItem): string {
  const s = r.score;
  const ranked = TERM_KEYS.map((k) => [k, s[k]] as const).sort((a, b) => b[1] - a[1]);
  const top = TERM_LABELS[ranked[0][0]].toLowerCase();
  const second = TERM_LABELS[ranked[1][0]].toLowerCase();
  return `Strong on ${top} and ${second}; ${fmtHours(s.driveTimeHours)} drive within the ${Math.round(item.hoursToSpoil)}h window.`;
}

function firstName(full?: string): string {
  if (!full) return 'the donor';
  return full.trim().split(/\s+/)[0];
}
