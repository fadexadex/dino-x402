import { useEffect, useMemo, useRef, useState } from "react";
import { DinoMark } from "@/components/agent/DinoMark";
import { EventCard } from "@/components/agent/EventCard";
import { ProposalGate } from "@/components/agent/ProposalGate";
import { AutonomyDial } from "@/components/agent/AutonomyDial";
import { WatchStatus } from "@/components/agent/WatchStatus";
import { KillSwitch } from "@/components/agent/KillSwitch";
import { RunsRail } from "@/components/agent/RunsRail";
import { Composer } from "@/components/agent/Composer";
import { Inspector, type InspectorView } from "@/components/agent/Inspector";
import { ThinkingTrace } from "@/components/kit/ThinkingTrace";
import type { AgentEvent, AutonomyMode, Limits } from "@/lib/agent-types";
import { useVariant, useVariants } from "@/lib/variants";
import { api } from "@/lib/agent-api";
import { isUserFacingKind, toEvent, toHoldings, toProposal } from "@/lib/agent-view";
import { signAndExecuteSwap } from "@/lib/wallet-sign";
import { useAgentDashboard } from "./useAgentDashboard";

/** Locked-in scroll style for the workspace rail. */
const WORKSPACE_SCROLL = "scroll-snap-cards scroll-fade";

export function DinoWorkspace() {
  const { data, loading, error, refresh } = useAgentDashboard();
  const profile = data?.profile;
  const [mode, setMode] = useState<AutonomyMode>(profile?.autonomyMode ?? 3);
  const [limits, setLimits] = useState<Limits>({ maxPerTrade: 0, maxTradesPerDay: 0, maxPortfolioMovePct: 0, maxDailySpend: 0, allowList: ["HBAR", "USDC", "SAUCE"] });
  const [paused, setPaused] = useState(false);
  const [cadenceMs, setCadenceMs] = useState((profile?.cadenceMinutes ?? 15) * 60 * 1000);
  const [inspector, setInspector] = useState<InspectorView | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingObjective, setPendingObjective] = useState<string | null>(null);
  const proposalVariant = useVariant("proposal");
  const rightNowPlacement = useVariant("rightNow");
  const graphPlacement = useVariant("graphPlacement");
  const [railOpen, setRailOpen] = useState(true);

  const { density } = useVariants();
  const streamRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const proposal = data?.pendingProposals?.[0] ?? data?.proposals?.[0];
  const waitingRunId = data?.runs?.find((item) => item.status === "waiting_approval")?.id;
  const latestRunId = waitingRunId ?? data?.runs?.[0]?.id;
  // Prefer curated titles from the server; drop bare "trade rejected" audit leftovers.
  const visibleEvents = (data?.events ?? []).filter((event) => {
    if (!isUserFacingKind(event.kind)) return false;
    if (event.kind === "trade.rejected" && (!event.title || event.title === "trade rejected")) return false;
    return true;
  });
  const rawEvents = latestRunId
    ? visibleEvents.filter((event) => event.runId === latestRunId)
    : visibleEvents.slice(-20);
  const receipts = data?.receipts ?? [];
  const baseEvents = useMemo(() => rawEvents.map((event) => toEvent(event, receipts)), [rawEvents, receipts]);
  const events = useMemo(() => {
    const mapped = [...baseEvents];
    if (pendingObjective && sending) {
      mapped.unshift({
        id: "optimistic-run",
        step: "trigger",
        at: Date.now(),
        title: "Starting check-in",
        detail: pendingObjective,
        tone: "signal",
      });
    }
    return mapped;
  }, [baseEvents, pendingObjective, sending]);
  const halted = Boolean(data?.system?.halted || profile?.status === "halted");
  const connected = Boolean(profile?.accountId);
  const awaiting = Boolean(proposal);
  const working = sending || loading || data?.runs?.[0]?.status === "running";
  const run = {
    events,
    ticks: data?.graph?.ticks?.map((tick) => ({ ...tick, provenance: tick.provenance === "stale" ? "fallback" as const : tick.provenance })) ?? [],
    markers: data?.graph?.markers ?? events.filter((event) => event.purchase || event.proposal || event.settlement).map((event) => ({ t: event.at, eventId: event.id })),
    halted,
    connected,
    phase: awaiting ? "awaiting" : working ? "running" : "idle",
    connect: refresh,
    disconnect: refresh,
    approve: async () => {
      if (!proposal) return;
      try {
        const result = await api.approve(proposal.id);
        if (result?.status === "needs_wallet_signature" && result.signing && result.accountId) {
          const { transactionId } = await signAndExecuteSwap(result.accountId, result.signing);
          await api.confirmProposal(proposal.id, transactionId);
        }
      } finally {
        await refresh();
      }
    },
    decline: async () => { if (proposal) { await api.reject(proposal.id); await refresh(); } },
    halt: async () => { await api.halt(); await refresh(); },
    resume: async () => { await api.resume(); await refresh(); },
  };

  const onSend = async (objective: string) => {
    if (!profile || sending) return;
    setSending(true);
    setSendError(null);
    setPendingObjective(objective);
    const poll = window.setInterval(() => { void refresh(); }, 1_200);
    try {
      await api.updateMandate(profile.id, { objective });
      await api.run(profile.id, objective);
      await refresh();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Could not start the agent run.");
    } finally {
      window.clearInterval(poll);
      setSending(false);
      setPendingObjective(null);
    }
  };

  useEffect(() => {
    if (data?.schedule?.autonomyMode ?? profile?.autonomyMode) setMode(data?.schedule?.autonomyMode ?? profile?.autonomyMode ?? 3);
    if (data?.schedule?.cadenceMinutes ?? profile?.cadenceMinutes) setCadenceMs((data?.schedule?.cadenceMinutes ?? profile?.cadenceMinutes ?? 15) * 60_000);
    setPaused(Boolean(data?.schedule?.paused ?? profile?.status === "paused"));
    const configured = data?.mandate?.limits;
    if (configured) setLimits({ maxPerTrade: Number(configured.maxPerTrade ?? 0), maxTradesPerDay: Number(configured.maxTradesPerDay ?? 0), maxPortfolioMovePct: Number(configured.maxPortfolioMovePct ?? 0), maxDailySpend: Number(configured.maxDailySpend ?? 0), allowList: configured.allowList ?? ["HBAR", "USDC", "SAUCE"] });
  }, [data?.schedule, data?.mandate?.limits, profile?.autonomyMode, profile?.cadenceMinutes, profile?.status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "b" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setRailOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


  const proposalEvent = run.events.find((e) => e.proposal);
  const lastCheckIn = run.events.at(-1)?.at ?? Date.now();

  // keep the stream pinned to the newest step unless the user scrolled up
  useEffect(() => {
    const el = streamRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [run.events.length, run.phase]);

  const onStreamScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const openInspector = (view: InspectorView, id?: string) => {
    setInspector(view);
    if (id) setFocusId(id);
  };

  const inspect = (event: AgentEvent) => openInspector("trace", event.id);

  const liveRows = useMemo(
    () =>
      run.events.slice(-4).map((e) => ({
        primary: e.title,
        secondary: e.step,
        tone: e.tone ?? "ink",
      })),
    [run.events],
  );

  const rightNow = (
    <ThinkingTrace
      activeLabel={
        run.phase === "connecting"
          ? "Connecting your wallet" : "Working the check-in"
      }
      doneLabel={
        awaiting
          ? "Paused for your approval"
          : run.halted
            ? "Halted"
            : run.connected
              ? `Ran ${run.events.length} steps` : "No account connected"
      }
      rows={liveRows}
      visible={liveRows.length}
      working={working}
      defaultExpanded={rightNowPlacement !== "Sticky under header"}
      onRowClick={(_r, i) => {
        const ev = run.events.slice(-4)[i];
        if (ev) inspect(ev);
      }}
    />
  );

  const rightNowCard = (
    <div className="rounded-lg border border-line bg-card p-3">
      <p className="text-[10.5px] font-medium tracking-[0.09em] text-ink-3 uppercase">Right now</p>
      <div className="mt-2">{rightNow}</div>
    </div>
  );

  const gap = density === "compact" ? "gap-3" : "gap-5";

  const panel = (tall: boolean) =>
    inspector ? (
      <Inspector
        view={inspector}
        ticks={run.ticks}
        markers={run.markers}
        events={run.events}
        focusId={focusId}
        tall={tall}
        onView={setInspector}
        onFocus={setFocusId}
        onClose={() => setInspector(null)}
        spend={{
          dataAllTime: Number(data?.spend?.dataHbar ?? 0),
          dataToday: Number(data?.spend?.dataTodayHbar ?? 0),
          tradeVolumeAllTime: Number(data?.spend?.tradeHbar ?? 0),
          tradeVolumeToday: Number(data?.spend?.tradeTodayHbar ?? 0),
          paidReadsAllTime: receipts.filter((receipt) => receipt.kind === "data_purchase").length,
          tradesAllTime: receipts.filter((receipt) => receipt.kind === "trade").length,
          networkFeesAllTime: Number(data?.spend?.networkHbar ?? 0),
          unit: "HBAR",
        }}
      />
    ) : null;


  return (
    <div className="flex h-screen flex-col bg-paper text-ink">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="flex items-center gap-2 text-ink">
          <DinoMark />
          <span className="text-[13.5px] font-semibold tracking-[-0.01em]">Dino Agent</span>
        </span>
        <button
          type="button"
          onClick={() => { window.location.href = "/connect"; }}
          className="hidden items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 font-mono text-[11px] text-ink-3 transition-colors hover:bg-hover sm:flex"
        >
          <span className={`size-1.5 rounded-full ${run.connected ? "bg-green" : "bg-ink-3"}`} />
          {run.connected ? `${profile?.accountId} · ${profile?.network ?? "testnet"}` : "connect wallet"}
        </button>
        <div className="ml-auto flex items-center gap-2">
          <WatchStatus
            lastCheckIn={lastCheckIn}
            cadenceMs={cadenceMs}
            onCadenceChange={(next) => { setCadenceMs(next); if (profile) void api.setSchedule(profile.id, Math.round(next / 60_000), paused).then(refresh); }}
            paused={paused || data?.schedule?.paused || run.halted || !run.connected}
            onTogglePause={() => { const next = !paused; setPaused(next); if (profile) void api.setSchedule(profile.id, Math.round(cadenceMs / 60_000), next).then(refresh); }}
          />
          <button
            type="button"
            onClick={() => openInspector(inspector === "graph" ? "trace" : "graph")}
            className="rounded-control border border-line bg-card px-2.5 py-1.5 text-[12px] text-ink-2 transition-colors hover:bg-hover"
          >
            Graph
          </button>
          <KillSwitch halted={run.halted} onHalt={() => void run.halt()} onResume={() => void run.resume()} />
        </div>
      </header>

      {rightNowPlacement === "Sticky under header" && (
        <div className="shrink-0 border-b border-line bg-card/70 px-5 py-2">
          <div className="mx-auto w-full max-w-3xl">{rightNow}</div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div
          className={`hidden shrink-0 overflow-hidden border-r border-line transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] lg:block ${
            railOpen ? "w-[260px]" : "w-[52px]"
          }`}
        >
          {railOpen ? (
            <div className="flex h-full w-[260px] min-h-0 flex-col p-3">
              <div className="flex shrink-0 items-center justify-between gap-1 pb-3">
                <span className="min-w-0 truncate text-[10.5px] font-medium tracking-[0.09em] text-ink-3 uppercase">
                  Workspace
                </span>
                <button
                  type="button"
                  onClick={() => setRailOpen(false)}
                  aria-label="Collapse sidebar"
                  title="Collapse sidebar (⌘B)"
                  className="rounded-control px-1.5 py-1 text-[12px] text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                >
                  ⟨⟨
                </button>
              </div>
              <div
                className={`-mr-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain scroll-smooth pr-1 ${WORKSPACE_SCROLL}`}
              >
                {rightNowPlacement === "Left rail" && rightNowCard}
                <RunsRail pendingCount={awaiting ? 1 : 0} holdings={toHoldings(data?.portfolio)} objective={data?.mandate?.objective} runs={(data?.runs ?? []).slice(0, 5).map((item) => ({ id: item.id, label: item.objective ?? "Portfolio check-in", status: item.status ?? "Recorded", tone: item.status === "failed" ? "orange" : item.status === "completed" ? "green" : item.status === "waiting_approval" ? "orange" : "muted" }))} />
              </div>
            </div>

          ) : (
            <div className="flex h-full w-[52px] flex-col items-center gap-3 py-3">
              <button
                type="button"
                onClick={() => setRailOpen(true)}
                aria-label="Expand sidebar"
                title="Expand sidebar (⌘B)"
                className="rounded-control px-1.5 py-1 text-[12px] text-ink-3 transition-colors hover:bg-hover hover:text-ink"
              >
                ⟩⟩
              </button>
              <span
                className={`size-2 rounded-full ${working ? "animate-pulse bg-signal" : awaiting ? "bg-orange" : "bg-ink-3/40"}`}
                title={working ? "Agent working" : awaiting ? "Awaiting approval" : "Idle"}
              />
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <main className="flex min-h-0 flex-1 flex-col">
              <div
                ref={streamRef}
                onScroll={onStreamScroll}
                className={`flex min-h-0 flex-1 flex-col overflow-auto px-5 py-5 ${gap}`}
              >
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
                  <section
                    className={`grid gap-3 ${rightNowPlacement === "Inline card" ? "sm:grid-cols-2" : ""}`}
                  >
                    <AutonomyDial
                      mode={mode}
                      limits={limits}
                      onChange={(next) => { setMode(next); if (profile) void api.setSchedule(profile.id, Math.round(cadenceMs / 60_000), paused, next).then(refresh); }}
                      onLimitsChange={(next) => { setLimits(next); if (profile) void api.updateMandate(profile.id, { risk: { maxTradeUsd: next.maxPerTrade, maxTradesPerDay: next.maxTradesPerDay, maxPortfolioMovePct: next.maxPortfolioMovePct, maxDailyDataHbar: next.maxDailySpend, allowList: next.allowList } }).then(refresh); }}
                    />
                    {rightNowPlacement === "Inline card" && rightNowCard}
                  </section>

                  {(error || sendError) && <section role="alert" className="rounded-lg border border-orange/30 bg-orange-soft p-3 text-[12px] text-orange">{sendError ?? error}</section>}
                  {awaiting && proposal && (
                    <section className="rounded-lg border border-orange/30 bg-card p-4">
                      <p className="text-[10.5px] font-medium tracking-[0.09em] text-orange uppercase">Needs your approval</p>
                      <div className="mt-2">
                        <ProposalGate
                          proposal={toProposal(proposal)}
                          onApprove={() => void run.approve()}
                          onDecline={() => void run.decline()}
                        />
                      </div>
                    </section>
                  )}
                  {!run.connected && (
                    <section className="rounded-lg border border-line bg-card p-5 text-center">
                      <p className="text-[14px] font-medium text-ink">
                        Connect an account to begin
                      </p>
                      <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-2">
                        The workspace will populate only after the server has an authenticated portfolio profile.
                      </p>
                      <div className="mt-3 flex items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => void run.connect()}
                          className="rounded-control bg-ink px-3 py-1.5 text-[12.5px] font-medium text-background"
                        >
                          Refresh profile
                        </button>
                        <a
                          href="/connect"
                          className="rounded-control border border-line px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-hover"
                        >
                          Pick a wallet
                        </a>
                      </div>
                    </section>
                  )}

                  <section className={`flex flex-col ${density === "compact" ? "gap-3" : "gap-4"}`}>
                    {run.events.map((event) => (
                      <EventCard
                        key={event.id}
                        event={event}
                        onInspect={inspect}
                        onGraph={(e) => openInspector("graph", e.id)}
                      />
                    ))}
                  </section>
                </div>
              </div>

              <div className="shrink-0 border-t border-line bg-paper px-5 py-3">
                <div className="mx-auto w-full max-w-3xl">
                  {rightNowPlacement === "Above composer" && <div className="mb-3">{rightNow}</div>}
                  <Composer onSend={(objective) => { void onSend(objective); }} disabled={run.halted || !profile || sending} accountLabel={profile?.accountId ? `${profile.accountId} · ${profile.network ?? "testnet"}` : undefined} />
                  <p className="mt-2 text-[11px] text-ink-3">
                    Mode {mode} · every paid read and every trade is on-chain and inspectable ·{" "}
                    <a href="/connect" className="animated-underline text-ink-2">
                      wallet
                    </a>
                  </p>
                </div>
              </div>
            </main>

            {inspector && graphPlacement === "Split right" && (
              <div className="hidden min-h-0 w-[460px] shrink-0 lg:block xl:w-[580px] 2xl:w-[720px]">
                {panel(false)}
              </div>
            )}
          </div>

          {inspector && graphPlacement === "Split bottom" && (
            <div className="hidden h-[48vh] shrink-0 border-t border-line lg:block">
              {panel(true)}
            </div>
          )}
        </div>
      </div>

      {inspector && graphPlacement === "Full focus" && (
        <div className="fixed inset-0 z-40 bg-paper p-3">
          <div className="mx-auto h-full max-w-5xl overflow-hidden rounded-xl border border-line shadow-2xl">
            {panel(true)}
          </div>
        </div>
      )}

      {inspector && (graphPlacement === "Right drawer" || graphPlacement === "Split right") && (
        <div
          className={`fixed inset-0 z-40 flex ${graphPlacement === "Split right" ? "lg:hidden" : ""}`}
        >
          <button
            type="button"
            aria-label="Close inspector"
            onClick={() => setInspector(null)}
            className="flex-1 bg-ink/20"
          />
          <div className="h-full w-[min(460px,94vw)] shadow-xl">{panel(false)}</div>
        </div>
      )}

      {inspector && graphPlacement === "Split bottom" && (
        <div className="fixed inset-0 z-40 flex flex-col lg:hidden">
          <button
            type="button"
            aria-label="Close inspector"
            onClick={() => setInspector(null)}
            className="flex-1 bg-ink/20"
          />
          <div className="h-[70vh] shadow-xl">{panel(true)}</div>
        </div>
      )}


      {awaiting && proposalEvent?.proposal && proposalVariant === "Takeover" && (
        <ProposalGate
          proposal={proposalEvent.proposal}
          onApprove={() => void run.approve()}
          onDecline={() => void run.decline()}
        />
      )}
    </div>
  );
}
