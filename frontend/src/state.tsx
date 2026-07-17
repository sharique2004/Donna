import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { humanize } from './theme';
import type {
  AgentConfig, CallAttempt, CallLogEntry, Channel, Donation, EnrichedDonation, EquitySimResult,
  ManagerReply, ManualCallInput, Mode, RankResponse, RankedRecipient, Recipient, Weights,
} from './types';

export interface ChatMsg { role: 'user' | 'bot'; text: string; reply?: ManagerReply }

interface Toast { text: string; error?: boolean }

interface DonnaState {
  mode: Mode | null;
  recipients: Recipient[];
  recipientsById: Record<string, Recipient>;
  config: AgentConfig | null;
  donations: Donation[];
  calls: CallLogEntry[];
  current: EnrichedDonation | null;
  selectedItemId: string | null;
  selectedRecipientId: string | null;
  detailOpen: boolean;
  liveRank: Record<string, RankResponse>;
  equity: EquitySimResult | null;
  chat: ChatMsg[];
  appliedPatchCount: number;

  busy: { init: boolean; ingest: boolean; dispatch: boolean; equity: boolean; chat: boolean };
  toast: Toast | null;

  activeRankings: RankedRecipient[];
  activeExplanation: string;

  ingest: (channel: Channel, contact: string, rawText: string) => Promise<void>;
  loadCanned: () => Promise<void>;
  openItem: (donationId: string, itemId: string) => Promise<void>;
  closeDetail: () => void;
  selectRecipient: (id: string | null) => void;
  dispatch: () => Promise<void>;
  callRecipient: (itemId: string, recipientId: string) => Promise<CallAttempt>;
  logManualCall: (itemId: string, recipientId: string, input: ManualCallInput) => Promise<CallAttempt>;
  rerank: (itemId: string, weights: Weights) => Promise<void>;
  updateConfig: (patch: Partial<AgentConfig>) => Promise<void>;
  managerSend: (message: string) => Promise<void>;
  runEquity: (drops?: number) => Promise<void>;
  reset: () => Promise<void>;
  pushToast: (text: string, error?: boolean) => void;
}

const Ctx = createContext<DonnaState | null>(null);

export function useDonna(): DonnaState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDonna outside provider');
  return v;
}

export function DonnaProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [donations, setDonations] = useState<Donation[]>([]);
  const [calls, setCalls] = useState<CallLogEntry[]>([]);
  const [current, setCurrent] = useState<EnrichedDonation | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedRecipientId, setSelectedRecipientId] = useState<string | null>(null);
  const [liveRank, setLiveRank] = useState<Record<string, RankResponse>>({});
  const [equity, setEquity] = useState<EquitySimResult | null>(null);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [appliedPatchCount, setAppliedPatchCount] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState({ init: true, ingest: false, dispatch: false, equity: false, chat: false });

  const toastTimer = useRef<number | undefined>(undefined);
  const pushToast = useCallback((text: string, error?: boolean) => {
    setToast({ text, error });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const setBusyKey = (k: keyof typeof busy, v: boolean) => setBusy((b) => ({ ...b, [k]: v }));

  const recipientsById = useMemo(() => {
    const m: Record<string, Recipient> = {};
    for (const r of recipients) m[r.id] = r;
    return m;
  }, [recipients]);

  const refreshRecipients = useCallback(async () => {
    try { setRecipients(await api.listRecipients()); } catch { /* ignore */ }
  }, []);

  const refreshList = useCallback(async () => {
    try { setDonations(await api.listDonations()); } catch { /* ignore */ }
  }, []);

  // §F — the Outbound feed reads GET /api/calls (flattened attempts). Silent.
  const refreshCalls = useCallback(async () => {
    try { setCalls(await api.getCalls()); } catch { /* ignore */ }
  }, []);

  // Fetch the ranking + explanation for one item (default/stored weights) so the
  // detail panel and map render from a fresh server rank. Silent on failure —
  // the pre-ranked enriched donation is the fallback.
  const fetchRank = useCallback(async (itemId: string, weights?: Weights) => {
    try {
      const r = await api.rank(itemId, weights);
      setLiveRank((m) => ({ ...m, [itemId]: r }));
    } catch { /* fall back to enriched rankings */ }
  }, []);

  // ---- init ----
  useEffect(() => {
    (async () => {
      try {
        const [h, recs, cfg, list, calls] = await Promise.allSettled([
          api.health(), api.listRecipients(), api.getConfig(), api.listDonations(), api.getCalls(),
        ]);
        if (h.status === 'fulfilled') setMode(h.value.mode);
        if (recs.status === 'fulfilled') setRecipients(recs.value);
        if (cfg.status === 'fulfilled') setConfig(cfg.value);
        if (list.status === 'fulfilled') setDonations(list.value);
        if (calls.status === 'fulfilled') setCalls(calls.value);
        if (h.status === 'rejected') pushToast('Backend offline — start donna-backend on :8787', true);
      } finally {
        setBusyKey('init', false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- live feed: silent poll every 3s (no spinners after first load) ----
  // Inbound (donations) + Outbound (calls) both refresh on the same tick.
  useEffect(() => {
    const id = window.setInterval(() => { void refreshList(); void refreshCalls(); }, 3000);
    return () => window.clearInterval(id);
  }, [refreshList, refreshCalls]);

  const loadEnriched = useCallback((e: EnrichedDonation, openFirst: boolean) => {
    setCurrent(e);
    setLiveRank({});
    setSelectedRecipientId(null);
    const first = e.donation.items[0];
    if (openFirst && first) {
      setSelectedItemId(first.id);
      void fetchRank(first.id, config?.weights);
    } else {
      setSelectedItemId(null);
    }
  }, [config, fetchRank]);

  const ingest = useCallback(async (channel: Channel, contact: string, rawText: string) => {
    setBusyKey('ingest', true);
    try {
      const e = await api.ingest(channel, contact, rawText);
      loadEnriched(e, true);
      await refreshList();
      pushToast(`Parsed ${e.donation.items.length} item${e.donation.items.length === 1 ? '' : 's'}`);
    } catch (err: any) {
      pushToast(err.message || 'Ingest failed', true);
    } finally { setBusyKey('ingest', false); }
  }, [loadEnriched, refreshList, pushToast]);

  const loadCanned = useCallback(async () => {
    setBusyKey('ingest', true);
    try {
      const e = await api.canned();
      loadEnriched(e, true);
      await refreshList();
      pushToast('Canned scenario loaded');
    } catch (err: any) {
      pushToast(err.message || 'Canned load failed', true);
    } finally { setBusyKey('ingest', false); }
  }, [loadEnriched, refreshList, pushToast]);

  // Open a specific item's detail: ensure its donation is current, select it,
  // and fetch a fresh rank (rankings + why sentence).
  const openItem = useCallback(async (donationId: string, itemId: string) => {
    try {
      if (!current || current.donation.id !== donationId) {
        const e = await api.getDonation(donationId);
        setCurrent(e);
        setLiveRank({});
      }
      setSelectedItemId(itemId);
      setSelectedRecipientId(null);
      await fetchRank(itemId, config?.weights);
    } catch (err: any) {
      pushToast(err.message || 'Could not open item', true);
    }
  }, [current, config, fetchRank, pushToast]);

  const closeDetail = useCallback(() => {
    setSelectedItemId(null);
    setSelectedRecipientId(null);
    setCurrent(null);
    setLiveRank({});
  }, []);

  const selectRecipient = useCallback((id: string | null) => setSelectedRecipientId(id), []);

  const dispatch = useCallback(async () => {
    if (!current) return;
    setBusyKey('dispatch', true);
    try {
      await api.dispatch(current.donation.id);
      const e = await api.getDonation(current.donation.id);
      setCurrent((prev) => ({
        donation: e.donation,
        rankings: Object.keys(e.rankings || {}).length ? e.rankings : (prev?.rankings ?? {}),
      }));
      await Promise.all([refreshList(), refreshCalls(), refreshRecipients()]);
      pushToast('Dispatch complete — donor notified');
    } catch (err: any) {
      pushToast(err.message || 'Dispatch failed', true);
    } finally { setBusyKey('dispatch', false); }
  }, [current, refreshList, refreshCalls, refreshRecipients, pushToast]);

  // After a directed or manual call resolves, pull every DB-derived surface back
  // in sync (inbound items, network call history, recipient ledgers) and refresh
  // the open Detail view if one is mounted. All state comes from these fetches.
  const syncAfterCall = useCallback(async () => {
    await Promise.all([refreshList(), refreshCalls(), refreshRecipients()]);
    if (current) {
      try {
        const e = await api.getDonation(current.donation.id);
        setCurrent((prev) => ({
          donation: e.donation,
          rankings: Object.keys(e.rankings || {}).length ? e.rankings : (prev?.rankings ?? {}),
        }));
      } catch { /* keep prior current */ }
    }
  }, [refreshList, refreshCalls, refreshRecipients, current]);

  // §G.2 — "Donna, call": directed agent call to one recipient for one pending item.
  const callRecipient = useCallback(async (itemId: string, recipientId: string) => {
    try {
      const res = await api.callRecipient(itemId, recipientId);
      await syncAfterCall();
      const ok = res.attempt.outcome === 'accepted';
      pushToast(ok ? `${res.attempt.recipientName} accepted` : `${res.attempt.recipientName} — ${res.attempt.reason || humanize(res.attempt.outcome)}`, !ok && res.attempt.outcome === 'declined');
      return res.attempt;
    } catch (err: any) {
      pushToast(err.message || 'Call failed', true);
      throw err;
    }
  }, [syncAfterCall, pushToast]);

  // §G.2 — "Log manual call": human-recorded outcome, persisted like an agent call.
  const logManualCall = useCallback(async (itemId: string, recipientId: string, input: ManualCallInput) => {
    try {
      const res = await api.logManualCall(itemId, recipientId, input);
      await syncAfterCall();
      pushToast('Manual call logged');
      return res.attempt;
    } catch (err: any) {
      pushToast(err.message || 'Could not log call', true);
      throw err;
    }
  }, [syncAfterCall, pushToast]);

  const rerank = useCallback(async (itemId: string, weights: Weights) => {
    try {
      const r = await api.rank(itemId, weights);
      setLiveRank((m) => ({ ...m, [itemId]: r }));
    } catch (err: any) {
      pushToast(err.message || 'Re-rank failed', true);
    }
  }, [pushToast]);

  const updateConfig = useCallback(async (patch: Partial<AgentConfig>) => {
    try {
      const cfg = await api.putConfig(patch);
      setConfig(cfg);
    } catch (err: any) { pushToast(err.message || 'Config update failed', true); }
  }, [pushToast]);

  const managerSend = useCallback(async (message: string) => {
    setChat((c) => [...c, { role: 'user', text: message }]);
    setBusyKey('chat', true);
    try {
      const reply = await api.managerChat(message);
      setChat((c) => [...c, { role: 'bot', text: reply.reply, reply }]);
      if (reply.applied && reply.patches.length) {
        setAppliedPatchCount((n) => n + reply.patches.length);
        await Promise.all([refreshRecipients(), (async () => {
          try { setConfig(await api.getConfig()); } catch { /* */ }
        })()]);
        if (selectedItemId) { void fetchRank(selectedItemId, config?.weights); }
      }
    } catch (err: any) {
      setChat((c) => [...c, { role: 'bot', text: `Sorry — ${err.message || 'that failed'}.` }]);
    } finally { setBusyKey('chat', false); }
  }, [refreshRecipients, selectedItemId, config, fetchRank]);

  const runEquity = useCallback(async (drops = 30) => {
    setBusyKey('equity', true);
    try { setEquity(await api.equitySimulate(drops)); }
    catch (err: any) { pushToast(err.message || 'Simulation failed', true); }
    finally { setBusyKey('equity', false); }
  }, [pushToast]);

  const reset = useCallback(async () => {
    setBusyKey('init', true);
    try {
      await api.reset();
      setCurrent(null); setLiveRank({}); setEquity(null); setChat([]); setAppliedPatchCount(0);
      setSelectedItemId(null); setSelectedRecipientId(null); setCalls([]);
      await Promise.all([refreshRecipients(), refreshList(), refreshCalls(), (async () => {
        try { setConfig(await api.getConfig()); } catch { /* */ }
      })()]);
      pushToast('Demo reset');
    } catch (err: any) { pushToast(err.message || 'Reset failed', true); }
    finally { setBusyKey('init', false); }
  }, [refreshRecipients, refreshList, refreshCalls, pushToast]);

  const detailOpen = useMemo<boolean>(() => (
    !!selectedItemId && !!current && current.donation.items.some((i) => i.id === selectedItemId)
  ), [selectedItemId, current]);

  const activeRankings = useMemo<RankedRecipient[]>(() => {
    if (!selectedItemId) return [];
    if (liveRank[selectedItemId]) return liveRank[selectedItemId].rankings;
    return current?.rankings[selectedItemId] ?? [];
  }, [selectedItemId, liveRank, current]);

  const activeExplanation = useMemo<string>(() => {
    if (selectedItemId && liveRank[selectedItemId]) return liveRank[selectedItemId].explanation;
    return '';
  }, [selectedItemId, liveRank]);

  const value: DonnaState = {
    mode, recipients, recipientsById, config, donations, calls, current,
    selectedItemId, selectedRecipientId, detailOpen, liveRank, equity, chat, appliedPatchCount,
    busy, toast, activeRankings, activeExplanation,
    ingest, loadCanned, openItem, closeDetail, selectRecipient, dispatch,
    callRecipient, logManualCall,
    rerank, updateConfig, managerSend, runEquity, reset, pushToast,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
