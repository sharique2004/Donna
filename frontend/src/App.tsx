import React, { useState } from 'react';
import './styles.css';
import { DonnaProvider, useDonna } from './state';
import { Feed } from './components/Feed';
import { IntakeModal } from './components/IntakeModal';
import { MapView } from './components/MapView';
import { DetailPanel } from './components/DetailPanel';
import { NetworkPanel } from './components/NetworkPanel';
import { DemoStage } from './components/DemoStage';
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
  const { mode, reset, busy, toast, detailOpen, appliedPatchCount } = useDonna();
  // Boots into the Dispatch console (§I.1): the inbound/outbound ops view is the
  // default face of the product; the Demo tab is opt-in.
  const [view, setView] = useState<View>('dispatch');
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [mgrOpen, setMgrOpen] = useState(false);

  const live = !!mode && (mode.llm !== 'mock' || mode.db !== 'json' || mode.voice !== 'sim');
  const modeTip = mode ? `LLM ${mode.llm} · DB ${mode.db} · Voice ${mode.voice}` : 'connecting…';

  return (
    <div className="app">
      {/* full-bleed map hero under everything */}
      <MapView />

      <header className="hbar">
        <span className="wordmark">Donna<span className="wm-dot">.</span></span>
        <div className="seg">
          <button className={`seg-btn${view === 'dispatch' ? ' on' : ''}`} onClick={() => setView('dispatch')}>Dispatch</button>
          <button className={`seg-btn${view === 'demo' ? ' on' : ''}`} onClick={() => setView('demo')}>Demo</button>
        </div>
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
        <button className="icon-btn" onClick={reset} disabled={busy.init} title="Reset demo" aria-label="Reset demo"><RotateCcw /></button>
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
