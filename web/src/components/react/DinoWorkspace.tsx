import { useEffect, useMemo, useRef, useState } from "react";
import { DinoMark } from "@/components/agent/DinoMark";
import { EventCard } from "@/components/agent/EventCard";
import { UserMessage } from "@/components/agent/UserMessage";
import { ConclusionCard } from "@/components/agent/ConclusionCard";
import { ProposalGate } from "@/components/agent/ProposalGate";
import { AutonomyDial } from "@/components/agent/AutonomyDial";
import { WatchStatus } from "@/components/agent/WatchStatus";
import { KillSwitch } from "@/components/agent/KillSwitch";
import { RunsRail } from "@/components/agent/RunsRail";
import { SessionSwitcher } from "@/components/agent/SessionSwitcher";
import { Composer } from "@/components/agent/Composer";
import { Inspector, type InspectorView } from "@/components/agent/Inspector";
import { ThinkingTrace } from "@/components/kit/ThinkingTrace";
import { ThinkingReasoning } from "@/components/kit/ThinkingReasoning";
import type { AgentEvent, AutonomyMode, Limits } from "@/lib/agent-types";
import { useVariant, useVariants } from "@/lib/variants";
import { api } from "@/lib/agent-api";
import { isConclusionKind, isStreamMetaKind, isUserFacingKind, reconcileSettlements, toEvent, toHoldings, toProposal } from "@/lib/agent-view";
import { signAndExecuteSwap } from "@/lib/wallet-sign";
import { connectWallet, disconnectWallet, getConnectedAccountId, getConnector, walletConfig } from "@/lib/wallet";
import { useAgentDashboard } from "./useAgentDashboard";

type ChatItem =
  | { type: "user"; id: string; at: number; text: string }
  | { type: "thoughts"; id: string; at: number; sentences: string[]; working: boolean; startedAt: number }
  | { type: "event"; id: string; at: number; event: AgentEvent };

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
  const [approving, setApproving] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [localUserMessages, setLocalUserMessages] = useState<Array<{ id: string; at: number; text: string }>>([]);
  const [thoughtStartedAt, setThoughtStartedAt] = useState<number | null>(null);
  const proposalVariant = useVariant("proposal");
  const rightNowPlacement = useVariant("rightNow");
  const graphPlacement = useVariant("graphPlacement");
  const [railOpen, setRailOpen] = useState(true);

  const { density } = useVariants();
  const streamRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const proposal = data?.pendingProposals?.[0] ?? data?.proposals?.[0];
  const waitingRunId = data?.runs?.find((item) => item.status === "waiting_approval")?.id;
  const runningRunId = data?.runs?.find((item) => item.status === "running")?.id;
  const latestRunId = waitingRunId ?? runningRunId ?? data?.runs?.[0]?.id;
  // Keep the live thought stream attached to the active run; while Send is in-flight,
  // hold the previous run until the new running id arrives (avoids a blank Thinking panel).
  const thoughtRunId = runningRunId ?? waitingRunId ?? (!sending ? data?.runs?.[0]?.id ?? null : latestRunId ?? null);
  // Prefer curated titles from the server; drop bare "trade rejected" audit leftovers.
  const visibleEvents = (data?.events ?? []).filter((event) => {
    if (!isUserFacingKind(event.kind)) return false;
    if (event.kind === "trade.rejected" && (!event.title || event.title === "trade rejected")) return false;
    return true;
  });
  // Continuous chat: show the recent conversation across runs, not only the latest check-in.
  const recentRunIds = useMemo(() => {
    const ids = (data?.runs ?? []).slice(0, 8).map((item) => item.id);
    return new Set(ids);
  }, [data?.runs]);
  const rawEvents = useMemo(() => {
    const scoped = visibleEvents.filter((event) => !event.runId || recentRunIds.has(event.runId) || recentRunIds.size === 0);
    return scoped.slice(-120);
  }, [visibleEvents, recentRunIds]);
  const receipts = data?.receipts ?? [];
  const baseEvents = useMemo(
    () => reconcileSettlements(rawEvents.map((event) => toEvent(event, receipts))),
    [rawEvents, receipts],
  );
  const thoughtSentences = useMemo(
    () => {
      if (!thoughtRunId) return [];
      return visibleEvents
        .filter((event) => event.runId === thoughtRunId && event.kind === "agent.thinking")
        .map((event) => event.detail || event.title || "")
        .filter(Boolean) as string[];
    },
    [visibleEvents, thoughtRunId],
  );
  const serverUserTexts = useMemo(
    () =>
      new Set(
        visibleEvents
          .filter((event) => event.kind === "user.message")
          .map((event) => (event.detail || event.title || "").trim().toLowerCase()),
      ),
    [visibleEvents],
  );
  const latestRunEvents = useMemo(
    () => (latestRunId ? baseEvents.filter((event) => {
      const source = rawEvents.find((item) => item.id === event.id);
      return source?.runId === latestRunId;
    }) : baseEvents),
    [baseEvents, rawEvents, latestRunId],
  );
  const halted = Boolean(data?.system?.halted || profile?.status === "halted");
  const connected = Boolean(profile?.accountId && profile?.status === "active");
  const awaiting = Boolean(proposal);
  const working = sending || data?.runs?.[0]?.status === "running";
  const disconnectSession = async () => {
    setSessionBusy(true);
    setSendError(null);
    try {
      await api.disconnectAccount();
      await disconnectWallet();
      setLocalUserMessages([]);
      await refresh();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Could not disconnect the wallet session.");
    } finally {
      setSessionBusy(false);
    }
  };
  const activateSession = async (profileId: string) => {
    setSessionBusy(true);
    setSendError(null);
    try {
      const result = await api.activateProfile(profileId);
      const activated = result.profile;
      // Mode 3 needs the matching WalletConnect session for approve; Modes 1–2 can still observe.
      if (activated.kind === "user_wallet" && activated.accountId && walletConfig.enabled) {
        try {
          const connector = await getConnector();
          let current = getConnectedAccountId(connector);
          if (current !== activated.accountId) {
            current = await connectWallet({ force: Boolean(current) });
          }
          if (current !== activated.accountId) {
            setSendError(`Session active for ${activated.accountId}. Connect that wallet before approving trades.`);
          }
        } catch {
          if ((activated.autonomyMode ?? 1) >= 3) {
            setSendError("Session activated. Reconnect the matching wallet before approving trades.");
          }
        }
      }
      setLocalUserMessages([]);
      await refresh();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Could not switch sessions.");
    } finally {
      setSessionBusy(false);
    }
  };
  const run = {
    events: latestRunEvents.filter((event) => !isStreamMetaKind(event.kind ?? "") && !isConclusionKind(event.kind ?? "")),
    ticks: data?.graph?.ticks?.map((tick) => ({ ...tick, provenance: tick.provenance === "stale" ? "fallback" as const : tick.provenance })) ?? [],
    markers: data?.graph?.markers ?? latestRunEvents.filter((event) => event.purchase || event.proposal || event.settlement).map((event) => ({ t: event.at, eventId: event.id })),
    halted,
    connected,
    phase: awaiting ? "awaiting" as const : working ? "running" as const : "idle" as const,
    connect: refresh,
    disconnect: () => void disconnectSession(),
    approve: async () => {
      if (!proposal || approving) return;
      setApproving(true);
      setSendError(null);
      try {
        const result = await api.approve(proposal.id);
        if (result?.status === "needs_wallet_signature") {
          if (!result.signing || !result.accountId) {
            throw new Error("Server asked for a wallet signature but did not return signing details.");
          }
          setSendError("Opening your wallet — approve the association / spend / swap prompts to finish.");
          const { transactionId } = await signAndExecuteSwap(result.accountId, result.signing);
          await api.confirmProposal(proposal.id, transactionId);
          setSendError(null);
        } else if (result?.status && result.status !== "approved") {
          throw new Error(result.message || `Unexpected approve status: ${result.status}`);
        }
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Could not approve the trade in your wallet.");
      } finally {
        setApproving(false);
        await refresh();
      }
    },
    decline: async () => {
      if (!proposal || approving) return;
      setApproving(true);
      setSendError(null);
      try {
        await api.reject(proposal.id);
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Could not decline the proposal.");
      } finally {
        setApproving(false);
        await refresh();
      }
    },
    halt: async () => { await api.halt(); await refresh(); },
    resume: async () => { await api.resume(); await refresh(); },
  };

  const chatItems = useMemo(() => {
    const items: ChatItem[] = [];
    for (const message of localUserMessages) {
      if (!serverUserTexts.has(message.text.trim().toLowerCase())) {
        items.push({ type: "user", id: message.id, at: message.at, text: message.text });
      }
    }
    const mappedById = new Map(baseEvents.map((event) => [event.id, event]));
    // Insert a completed-run thought block after each run's last non-meta event.
    const thoughtsByRun = new Map<string, string[]>();
    for (const event of rawEvents) {
      if (event.kind !== "agent.thinking" || !event.runId) continue;
      const list = thoughtsByRun.get(event.runId) ?? [];
      const line = event.detail || event.title || "";
      if (line) list.push(line);
      thoughtsByRun.set(event.runId, list);
    }
    const emittedThoughtRuns = new Set<string>();
    for (const event of rawEvents) {
      if (event.kind === "user.message") {
        items.push({
          type: "user",
          id: event.id,
          at: event.occurredAt ? new Date(event.occurredAt).getTime() : Date.now(),
          text: event.detail || event.title || "",
        });
        continue;
      }
      if (event.kind === "agent.thinking") continue;
      // Skip operational band-check cards that only duplicate the conclusion body.
      if (
        event.kind === "analysis.completed"
        && typeof event.detail === "string"
        && /all allocation bands are satisfied/i.test(event.detail)
      ) {
        continue;
      }
      const mapped = mappedById.get(event.id) ?? toEvent(event, receipts);
      items.push({
        type: "event",
        id: event.id,
        at: event.occurredAt ? new Date(event.occurredAt).getTime() : Date.now(),
        event: mapped,
      });
      if (event.kind === "run.completed" && event.runId && !emittedThoughtRuns.has(event.runId)) {
        const sentences = thoughtsByRun.get(event.runId) ?? [];
        if (sentences.length && event.runId !== thoughtRunId) {
          emittedThoughtRuns.add(event.runId);
          items.push({
            type: "thoughts",
            id: `thoughts-${event.runId}`,
            at: (event.occurredAt ? new Date(event.occurredAt).getTime() : Date.now()) - 1,
            sentences,
            working: false,
            startedAt: event.occurredAt ? new Date(event.occurredAt).getTime() : Date.now(),
          });
        }
      }
    }
    // Live thinking lives in the Right now rail — avoid a second blank Thinking card in chat.
    return items.sort((a, b) => a.at - b.at);
  }, [localUserMessages, serverUserTexts, rawEvents, receipts, baseEvents, thoughtRunId]);

  useEffect(() => {
    if (working && thoughtStartedAt === null) setThoughtStartedAt(Date.now());
    if (!working && !sending) setThoughtStartedAt(null);
  }, [working, sending, thoughtStartedAt]);

  const onSend = async (objective: string) => {
    if (!profile || sending) return;
    const text = objective.trim();
    if (!text) return;
    setSending(true);
    setSendError(null);
    setThoughtStartedAt(Date.now());
    setLocalUserMessages((current) => [...current, { id: `local-${Date.now()}`, at: Date.now(), text }]);
    const poll = window.setInterval(() => { void refresh(); }, 1_200);
    try {
      await api.updateMandate(profile.id, { objective: text });
      await api.run(profile.id, text);
      await refresh();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Could not start the agent run.");
    } finally {
      window.clearInterval(poll);
      setSending(false);
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
  }, [chatItems.length, thoughtSentences.length, run.phase]);

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

  const liveRows = useMemo(() => {
    if (thoughtSentences.length > 0) {
      return thoughtSentences.slice(-5).map((sentence, index) => ({
        primary: sentence,
        secondary: working && index === Math.min(4, thoughtSentences.length - 1) ? "now" : "thought",
        tone: (working && index === Math.min(4, thoughtSentences.length - 1) ? "signal" : "ink") as AgentEvent["tone"],
      }));
    }
    return run.events.slice(-4).map((e) => ({
      primary: e.title,
      secondary: e.step,
      tone: e.tone ?? "ink",
    }));
  }, [thoughtSentences, run.events, working]);

  const rightNow = thoughtSentences.length > 0 || working ? (
    <ThinkingReasoning
      sentences={thoughtSentences}
      working={working}
      startedAt={thoughtStartedAt ?? undefined}
      resetKey={thoughtRunId ?? (sending ? "sending" : "idle")}
      placeholder="Reading the request and gathering live market context…"
    />
  ) : (
    <ThinkingTrace
      activeLabel="Working the check-in"
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
        weights={data?.graph?.weights ?? []}
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
        <SessionSwitcher
          profiles={data?.profiles ?? []}
          activeProfileId={data?.activeProfileId ?? profile?.id}
          connected={run.connected}
          busy={sessionBusy}
          onActivate={(profileId) => activateSession(profileId)}
          onDisconnect={() => disconnectSession()}
          onNewSession={() => { window.location.href = "/connect?new=1"; }}
        />
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
                  {run.connected && (
                  <section
                    className={`grid gap-3 ${rightNowPlacement === "Inline card" ? "sm:grid-cols-2" : ""}`}
                  >
                    <AutonomyDial
                      mode={mode}
                      limits={limits}
                      custody={profile?.kind === "agent_managed" ? "agent_managed" : "user_wallet"}
                      onChange={(next) => {
                        if (profile?.kind !== "agent_managed" && next === 4) {
                          window.location.href = "/connect";
                          return;
                        }
                        if (profile?.kind === "agent_managed" && next !== 4) {
                          window.location.href = "/connect";
                          return;
                        }
                        setMode(next);
                        if (profile) void api.setSchedule(profile.id, Math.round(cadenceMs / 60_000), paused, next).then(refresh).catch((err) => {
                          setSendError(err instanceof Error ? err.message : "Could not update autonomy mode.");
                        });
                      }}
                      onLimitsChange={(next) => { setLimits(next); if (profile) void api.updateMandate(profile.id, { risk: { maxTradeUsd: next.maxPerTrade, maxTradesPerDay: next.maxTradesPerDay, maxPortfolioMovePct: next.maxPortfolioMovePct, maxDailyDataHbar: next.maxDailySpend, allowList: next.allowList } }).then(refresh); }}
                    />
                    {rightNowPlacement === "Inline card" && rightNowCard}
                  </section>
                  )}

                  {/* Mobile holdings strip — desktop uses the left rail. */}
                  <section className="rounded-lg border border-line bg-card p-3 lg:hidden">
                    <p className="text-[10.5px] font-medium tracking-[0.09em] text-ink-3 uppercase">Holdings</p>
                    <ul className="mt-2 grid grid-cols-3 gap-2">
                      {toHoldings(data?.portfolio).slice(0, 3).map((holding) => (
                        <li key={holding.asset} className="min-w-0">
                          <p className="text-[11px] text-ink-2">{holding.asset}</p>
                          <p className="truncate font-mono text-[12px] text-ink tabular-nums">{holding.amount.toFixed(holding.asset === "HBAR" ? 2 : 2)}</p>
                        </li>
                      ))}
                      {toHoldings(data?.portfolio).length === 0 && (
                        <li className="col-span-3 text-[12px] text-ink-3">No live balances yet.</li>
                      )}
                    </ul>
                  </section>

                  {(error || sendError) && <section role="alert" className="rounded-lg border border-orange/30 bg-orange-soft p-3 text-[12px] text-orange">{sendError ?? error}</section>}
                  {awaiting && proposal && (
                    <section className="rounded-lg border border-orange/30 bg-card p-4">
                      <p className="text-[10.5px] font-medium tracking-[0.09em] text-orange uppercase">Needs your approval</p>
                      <div className="mt-2">
                        <ProposalGate
                          proposal={toProposal(proposal)}
                          busy={approving}
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
                        Start a new session with a wallet for approval-gated modes, switch into a saved session, or enable the autonomous agent treasury.
                      </p>
                      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                        {(data?.profiles ?? []).filter((item) => item.id !== "connected-wallet" && item.status !== "active").slice(0, 3).map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            disabled={sessionBusy}
                            onClick={() => void activateSession(item.id)}
                            className="rounded-control border border-line px-3 py-1.5 font-mono text-[12px] text-ink-2 hover:bg-hover"
                          >
                            Resume {item.accountId}
                          </button>
                        ))}
                        <a
                          href="/connect?new=1"
                          className="rounded-control bg-ink px-3 py-1.5 text-[12.5px] font-medium text-background"
                        >
                          New session
                        </a>
                        <a
                          href="/connect"
                          className="rounded-control border border-line px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-hover"
                        >
                          Onboard
                        </a>
                      </div>
                    </section>
                  )}

                  <section className={`flex flex-col ${density === "compact" ? "gap-3" : "gap-4"}`}>
                    {chatItems.map((item) => {
                      if (item.type === "user") {
                        return <UserMessage key={item.id} text={item.text} at={item.at} />;
                      }
                      if (item.type === "thoughts") {
                        // Live thoughts render in Right now; chat only keeps completed-run traces.
                        if (item.working) return null;
                        return (
                          <div key={item.id} className="rounded-lg border border-line bg-card/80 px-3.5 py-3">
                            <ThinkingReasoning
                              sentences={item.sentences}
                              working={false}
                              startedAt={item.startedAt}
                              resetKey={item.id}
                              placeholder="Reading the request and gathering live market context…"
                            />
                          </div>
                        );
                      }
                      if (isConclusionKind(item.event.kind ?? "")) {
                        return (
                          <ConclusionCard
                            key={item.id}
                            event={item.event}
                            bullets={item.event.bullets ?? []}
                          />
                        );
                      }
                      return (
                        <EventCard
                          key={item.id}
                          event={item.event}
                          onInspect={inspect}
                          onGraph={(e) => openInspector("graph", e.id)}
                        />
                      );
                    })}
                  </section>
                </div>
              </div>

              <div className="shrink-0 border-t border-line bg-paper px-5 py-3">
                <div className="mx-auto w-full max-w-3xl">
                  {rightNowPlacement === "Above composer" && <div className="mb-3">{rightNow}</div>}
                  {run.halted && run.connected && (
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-orange/30 bg-card px-3 py-2.5">
                      <p className="text-[12.5px] text-ink-2">
                        Everything is halted. Resume to send a check-in or let the schedule run.
                      </p>
                      <button
                        type="button"
                        onClick={() => void run.resume()}
                        className="rounded-control bg-ink px-3 py-1.5 text-[12px] font-medium text-background"
                      >
                        Resume everything
                      </button>
                    </div>
                  )}
                  <Composer onSend={(objective) => { void onSend(objective); }} disabled={run.halted || !run.connected || !profile || sending} accountLabel={profile?.accountId ? `${profile.accountId} · ${profile.network ?? "testnet"}` : undefined} />
                  <p className="mt-2 text-[11px] text-ink-3">
                    Mode {mode} · every paid read and every trade is on-chain and inspectable ·{" "}
                    <a href="/connect" className="animated-underline text-ink-2">
                      change setup
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
