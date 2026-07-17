import React, { useEffect, useRef, useState } from 'react';
import { useDonna } from '../state';
import type { ConfigPatch, ManagerReply } from '../types';
import { TERM_COLORS, TERM_LABELS, humanize } from '../theme';
import { TERM_KEYS } from '../types';
import { X, Check } from '../icons';

const SUGGESTIONS = [
  "St. Mary's just got a new walk-in freezer",
  'Oak Avenue only accepts canned and dry goods',
  'Stop sending fresh produce to Bayview',
];

export function ManagerDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { chat, managerSend, busy, config, updateConfig, recipientsById } = useDonna();
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chat, open]);

  const send = (msg?: string) => {
    const m = (msg ?? text).trim();
    if (!m || busy.chat) return;
    managerSend(m);
    setText('');
  };

  return (
    <>
      {open && <div className="drawer-scrim" onClick={onClose} />}
      <div className={`drawer${open ? ' open' : ''}`}>
        <div className="drawer-head">
          <div>
            <h3>Manager console</h3>
            <div className="sub">Teach Donna in plain English</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
        </div>

        <div className="drawer-cfg">
          <div className="cfg-row">
            <span className="cl">Autopilot</span>
            <div
              className={`toggle${config?.autopilot ? ' on' : ''}`}
              style={{ marginLeft: 'auto' }}
              onClick={() => config && updateConfig({ autopilot: !config.autopilot })}
              role="switch" aria-checked={!!config?.autopilot}
            >
              <span className="knob" />
            </div>
            <span className="cl" style={{ width: 26, textAlign: 'right', fontFamily: 'var(--mono)' }}>
              {config?.autopilot ? 'on' : 'off'}
            </span>
          </div>
          {config && (
            <div className="wt-readout">
              {TERM_KEYS.map((k) => (
                <span className="wt" key={k}>
                  <span className="sw" style={{ background: TERM_COLORS[k] }} />
                  {TERM_LABELS[k]} {config.weights[k].toFixed(2)}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          {chat.length === 0 && (
            <div style={{ color: 'var(--text-faint)', fontSize: 12.5, lineHeight: 1.6 }}>
              Tell Donna how the network changed — a new freezer, a shifted preference, a policy tweak.
              She proposes structured config patches; code validates and applies them.
            </div>
          )}
          {chat.map((m, i) => (
            <React.Fragment key={i}>
              <div className={`msg ${m.role}`}>{m.text}</div>
              {m.reply && <PatchChips reply={m.reply} name={(id?: string) => (id ? recipientsById[id]?.name || id : '')} />}
            </React.Fragment>
          ))}
          {busy.chat && <div className="msg bot"><span className="spinner" /></div>}

          {chat.length === 0 && (
            <div className="chat-suggest" style={{ marginTop: 8 }}>
              {SUGGESTIONS.map((s) => (
                <span key={s} className="sg" onClick={() => send(s)}>{s}</span>
              ))}
            </div>
          )}
        </div>

        <div className="drawer-input">
          <input
            value={text}
            placeholder="e.g. St. Mary's got a new freezer"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          />
          <button className="btn hot" onClick={() => send()} disabled={busy.chat || !text.trim()}>Send</button>
        </div>
      </div>
    </>
  );
}

function PatchChips({ reply, name }: { reply: ManagerReply; name: (id?: string) => string }) {
  if (!reply.patches.length) return null;
  return (
    <div className="patch-chips">
      {reply.patches.map((p, i) => (
        <div key={i} className={`patch-chip${reply.applied ? '' : ' rejected'}`}>
          <span className="pop-op">{reply.applied ? <Check size={13} /> : <X size={13} />}</span>
          {describePatch(p, name)}
        </div>
      ))}
    </div>
  );
}

function describePatch(p: ConfigPatch, name: (id?: string) => string): string {
  const who = name(p.recipientId);
  const v = p.value as any;
  switch (p.op) {
    case 'add_infrastructure': return `${who}: add ${humanize(v)}`;
    case 'remove_infrastructure': return `${who}: remove ${humanize(v)}`;
    case 'set_accepts': return `${who} accepts → ${arr(v)}`;
    case 'set_rejects': return `${who} rejects → ${arr(v)}`;
    case 'set_volume': return `${who} weekly volume → ${Number(v).toLocaleString()} lb`;
    case 'set_note': return `${who} note updated`;
    case 'set_autopilot': return `Autopilot → ${v ? 'on' : 'off'}`;
    case 'set_weights': return `Weights updated`;
    default: return `${p.op}`;
  }
}

function arr(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => humanize(x)).join(', ');
  return humanize(v);
}
