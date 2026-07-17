import React, { useMemo } from 'react';
import { useDonna } from '../state';
import type { Donation, DonationItem } from '../types';
import { humanize, spoilCountdown } from '../theme';
import { ChannelIcon, Snowflake, Route } from '../icons';

// §G.1 — Inbound is ITEM-CENTRIC: donations flattened to items, newest donation
// first. Each card ≤2 lines with an UNMISSABLE procurement state (§H.2: a colored
// 3px left rule + a small-caps status micro-label at line end): amber pending →
// green placed → red unplaceable (≤4% red card tint). Donation grouping survives
// only as a thin separator label.

const STATE_LABEL: Record<ItemState, string> = {
  pending: 'Pending',
  placed: 'Placed',
  unplaceable: 'No takers',
};

type ItemState = 'pending' | 'placed' | 'unplaceable';

function itemState(it: DonationItem): ItemState {
  if (it.status === 'matched') return 'placed';
  if (it.status === 'unplaceable') return 'unplaceable';
  return 'pending';
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function Feed({ onNew }: { onNew: () => void }) {
  const { donations, selectedItemId, current, openItem, busy, recipientsById } = useDonna();

  // Newest donation first; each contributes its ordered items.
  const groups = useMemo(() => donations.slice().reverse(), [donations]);
  const itemCount = useMemo(
    () => donations.reduce((n, d) => n + d.items.length, 0),
    [donations],
  );

  return (
    <aside className="feed">
      <div className="panel-head">
        <span className="panel-title">Inbound</span>
        {itemCount > 0 && <span className="panel-count">{itemCount}</span>}
      </div>

      <div className="feed-scroll">
        {groups.length === 0 ? (
          <div className="panel-empty">Waiting for donations…</div>
        ) : (
          groups.map((d) => (
            <div className="don-group" key={d.id}>
              <div className="don-sep">
                <span className="don-donor">{d.donorName || 'Unknown donor'}</span>
                <span className="don-meta">
                  <span className="ch-ico" title={humanize(d.sourceChannel)}><ChannelIcon channel={d.sourceChannel} size={13} /></span>
                  {fmtTime(d.receivedAt)}
                </span>
              </div>
              {d.items.map((it) => (
                <ItemCard
                  key={it.id}
                  d={d}
                  it={it}
                  recipientName={it.matchedRecipientId ? recipientsById[it.matchedRecipientId]?.name : undefined}
                  selected={current?.donation.id === d.id && selectedItemId === it.id}
                  onOpen={() => openItem(d.id, it.id)}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <button className="feed-new" onClick={onNew} disabled={busy.ingest}>+ Donation</button>
    </aside>
  );
}

function ItemCard({ d, it, recipientName, selected, onOpen }: {
  d: Donation; it: DonationItem; recipientName?: string;
  selected: boolean; onOpen: () => void;
}) {
  const state = itemState(it);
  const qty = Math.round(it.qtyLbs).toLocaleString();

  // Line 2 changes with the procurement state (§G.1). Status is a small-caps
  // micro-label at line end (§H.2), the 3px left rule is the only color element.
  let line2: React.ReactNode;
  if (state === 'placed') {
    line2 = <span className="l2-text ic-placed"><Route size={12} className="rt-glyph" /> → {recipientName || 'placed'}</span>;
  } else if (state === 'unplaceable') {
    line2 = <span className="l2-text ic-dead">no takers — donor notified</span>;
  } else {
    line2 = <span className="l2-text ic-donor">{d.donorName || 'Unknown donor'}</span>;
  }

  return (
    <button
      className={`icard ${state}${selected ? ' sel' : ''}`}
      onClick={onOpen}
      title={humanize(it.item)}
    >
      <span className="icard-edge" />
      <span className="icard-body">
        <span className="icard-l1">
          <span className="ic-name">{humanize(it.item)}</span>
          <span className="ic-qty">{qty} lb</span>
          <span className="ic-spoil">
            {it.needsRefrigeration && <span className="snow" title="Refrigerated"><Snowflake size={12} /></span>}
            {spoilCountdown(d.receivedAt, it.hoursToSpoil)}
          </span>
        </span>
        <span className="icard-l2">
          {line2}
          <span className={`status-tag ${state}`}>{STATE_LABEL[state]}</span>
        </span>
      </span>
    </button>
  );
}
