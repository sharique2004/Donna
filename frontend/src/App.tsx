import React, { useEffect, useState } from 'react';
import './styles.css';
import { DonnaProvider, useDonna } from './state';
import { Feed } from './components/Feed';
import { IntakeModal } from './components/IntakeModal';
import { MapView } from './components/MapView';
import { DetailPanel } from './components/DetailPanel';
import { NetworkPanel } from './components/NetworkPanel';
import { DemoStage, CLEAR_STAGE_EVENT } from './components/DemoStage';
import { WinConfetti } from './components/WinConfetti';
import { PitchStage } from './components/PitchStage';
import { ManagerDrawer } from './components/ManagerDrawer';
import { MessageSquare, RotateCcw } from './icons';

type View = 'dispatch' | 'demo' | 'pitch';

export default function App(): React.JSX.Element {
  return (
    <DonnaProvider>
      <Shell />
    </DonnaProvider>
  );
}

function Shell() {
  const { mode, reset, busy, toast, detailOpen, appliedPatchCount, closeDetail, pushToast } = useDonna();
  // Boots into the Pitch deck: the deck opens the room, then we cross to the
  // Dispatch console / Demo tab from the ribbon.
  const [view, setView] = useState<View>('pitch');
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [mgrOpen, setMgrOpen] = useState(false);
  // The ↺ popover: 'menu' offers Clear screen (client-only) beside Reset demo;
  // only the destructive path goes through the extra 'confirm' step.
  const [resetMenu, setResetMenu] = useState<'closed' | 'menu' | 'confirm'>('closed');

  // The deck's end-of-deck "See it in action" CTA posts up from its iframe.
  // Same-origin only — the deck is served from our own public/.
  useEffect(() => {
    const h = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data?.type === 'donna:see-demo') setView('demo');
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, []);

  const live = !!mode && (mode.llm !== 'mock' || mode.db !== 'json' || mode.voice !== 'sim');
  const modeTip = mode ? `LLM ${mode.llm} · DB ${mode.db} · Voice ${mode.voice}` : 'connecting…';

  return (
    <div className="app">
      {/* full-bleed map hero under everything */}
      <MapView />

      {/* One-shot celebration ~1.5s after load: pops from UNDER the win banner
          (the canvas layers below the ribbon, so pieces emerge from beneath it)
          and falls the full height of the page, then unmounts. */}
      <WinConfetti />

      <header className="hbar">
        <span className="wordmark">Donna<span className="wm-dot">.</span></span>
        <div className="seg">
          <button className={`seg-btn${view === 'dispatch' ? ' on' : ''}`} onClick={() => setView('dispatch')}>Dispatch</button>
          <button className={`seg-btn${view === 'demo' ? ' on' : ''}`} onClick={() => setView('demo')}>Demo</button>
        </div>
        <span className="win-banner" title="AI Supply Chain Hackathon — July 15–17 2026, San Francisco">
          <span className="wb-tag">Winner</span>
          <span className="wb-text">AI Supply Chain Hackathon 2026 · Pebblebed × Capgemini</span>
        </span>
        <div className="hspacer" />
        {/* Pitch sits at the right of the ribbon, immediately left of the mode
            tag: the deck opens the room, then we cross to Dispatch/Demo. */}
        <button
          className={`pitch-btn${view === 'pitch' ? ' on' : ''}`}
          onClick={() => setView(view === 'pitch' ? 'dispatch' : 'pitch')}
          title="Pitch deck"
        >
          Pitch
        </button>
        <span className={`mode-tag${live ? ' live' : ''}`} title={modeTip}>{live ? 'Live' : 'Sim'}</span>
        <button className="icon-btn mgr" onClick={() => setMgrOpen((o) => !o)} title="Manager console" aria-label="Manager console">
          <MessageSquare />{appliedPatchCount > 0 && <span className="badge">{appliedPatchCount}</span>}
        </button>
        {/* ↺ opens a two-option popover. Clear screen is client-only (stage back
            to idle, detail closed, store untouched) and fires straight away;
            Reset demo keeps the extra confirm because /api/demo/reset wipes
            every donation and call and reseeds the store. Clicking the icon
            again cancels either state. */}
        <button
          className={`icon-btn${resetMenu !== 'closed' ? ' armed' : ''}`}
          onClick={() => setResetMenu((s) => (s === 'closed' ? 'menu' : 'closed'))}
          disabled={busy.init}
          title="Clear or reset"
          aria-label="Clear or reset"
        >
          <RotateCcw />
        </button>
        {resetMenu === 'menu' && (
          <div className="confirm-pop" role="menu" aria-label="Clear or reset">
            <button
              className="cp-opt"
              onClick={() => {
                setResetMenu('closed');
                closeDetail();
                window.dispatchEvent(new Event(CLEAR_STAGE_EVENT));
                pushToast('Screen cleared — data kept');
              }}
            >
              <span className="cp-opt-name">Clear screen</span>
              <span className="cp-opt-desc">Put the stage back to idle. Keeps every donation and call.</span>
            </button>
            <button className="cp-opt danger" onClick={() => setResetMenu('confirm')}>
              <span className="cp-opt-name">Reset demo</span>
              <span className="cp-opt-desc">Wipe the store and restore the seed data.</span>
            </button>
          </div>
        )}
        {resetMenu === 'confirm' && (
          <div className="confirm-pop" role="alertdialog" aria-label="Confirm demo reset">
            <span className="cp-text">
              Reset the demo? Every donation and call is wiped and the seed data restored.
            </span>
            <div className="cp-actions">
              <button className="btn-quiet" onClick={() => setResetMenu('closed')}>Cancel</button>
              <button className="btn-primary" onClick={() => { setResetMenu('closed'); void reset(); }}>
                Reset demo
              </button>
            </div>
          </div>
        )}
      </header>

      {view === 'dispatch' && (
        <>
          <Feed onNew={() => setIntakeOpen(true)} />
          {/* right dock is always mounted: Outbound · Network directory by default,
              swaps to the item Detail view while an item is selected (§G) */}
          {detailOpen ? <DetailPanel /> : <NetworkPanel />}
        </>
      )}
      {view === 'demo' && <DemoStage />}
      {view === 'pitch' && <PitchStage />}

      {intakeOpen && <IntakeModal onClose={() => setIntakeOpen(false)} />}

      <ManagerDrawer open={mgrOpen} onClose={() => setMgrOpen(false)} />

      {toast && (
        <div className={`toast${toast.error ? ' err' : ''}`}>
          <span className="dot" />{toast.text}
        </div>
      )}
    </div>
  );
}
