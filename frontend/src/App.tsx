import React, { useState } from 'react';
import './styles.css';
import { DonnaProvider, useDonna } from './state';
import { Feed } from './components/Feed';
import { IntakeModal } from './components/IntakeModal';
import { MapView } from './components/MapView';
import { DetailPanel } from './components/DetailPanel';
import { NetworkPanel } from './components/NetworkPanel';
import { EquityTab } from './components/EquityTab';
import { ManagerDrawer } from './components/ManagerDrawer';

type View = 'dispatch' | 'equity';

export default function App(): React.JSX.Element {
  return (
    <DonnaProvider>
      <Shell />
    </DonnaProvider>
  );
}

function Shell() {
  const { mode, reset, busy, toast, detailOpen, appliedPatchCount } = useDonna();
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
        <span className="wordmark">Donna</span>
        <div className="seg">
          <button className={`seg-btn${view === 'dispatch' ? ' on' : ''}`} onClick={() => setView('dispatch')}>Dispatch</button>
          <button className={`seg-btn${view === 'equity' ? ' on' : ''}`} onClick={() => setView('equity')}>Equity</button>
        </div>
        <div className="hspacer" />
        <span className={`status-dot${live ? ' live' : ''}`} title={modeTip} />
        <button className="icon-btn mgr" onClick={() => setMgrOpen((o) => !o)} title="Manager console" aria-label="Manager console">
          🗨{appliedPatchCount > 0 && <span className="badge">{appliedPatchCount}</span>}
        </button>
        <button className="icon-btn" onClick={reset} disabled={busy.init} title="Reset demo" aria-label="Reset demo">↻</button>
      </header>

      {view === 'dispatch' ? (
        <>
          <Feed onNew={() => setIntakeOpen(true)} />
          {/* right dock is always mounted: Outbound · Network directory by default,
              swaps to the item Detail view while an item is selected (§G) */}
          {detailOpen ? <DetailPanel /> : <NetworkPanel />}
        </>
      ) : (
        <EquityTab />
      )}

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
