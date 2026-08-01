import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import type { DataProvider } from "../core/provider.js";
import type { ServerConfig } from "../core/config.js";
import { buildFacilitator } from "../core/facilitator.js";
import { validateRequest, productIdFromPath, priceForProduct } from "../core/catalog.js";
import { AgentRunner } from "../agent/runner.js";
import { MultiAssetAgentRunner } from "../agent/multi-runner.js";
import { agentScheduler } from "../scheduler/index.js";
import { store } from "../store/index.js";
import { findUserWalletForAccount, resolveActiveProfile, userWalletProfileId } from "../store/sessions.js";
import { sseBroadcaster } from "./stream.js";
import { readPortfolio } from "../portfolio/reader.js";
import { executeSaucerSwap } from "../trading/executor.js";
import { mergeLivePortfolioValuation, pricesUsdFromPortfolio, validateAllocationBands, valuePortfolio } from "../portfolio/allocation.js";
import { fetchDisplayUsdPrices } from "../providers/market/market-provider.js";
import type { AgentRunInput } from "../agent/types.js";
import type { DurableEvent, PortfolioMandate, PortfolioProfile, ScheduleConfig } from "../store/types.js";
import { eventForUi, isUserFacingEvent } from "./events.js";

const jsonSafe = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)) as T;

const unwrapPurchaseBody = (data: unknown): Record<string, unknown> | undefined => {
  if (!data || typeof data !== "object") return undefined;
  const outer = data as Record<string, unknown>;
  return outer.data && typeof outer.data === "object" ? outer.data as Record<string, unknown> : outer;
};

const priceFromPurchase = (data: unknown): number | undefined => {
  const body = unwrapPurchaseBody(data);
  const value = body?.price ?? body?.close;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const historyFromPurchase = (data: unknown): Array<{ t: number; price: number; provenance: "live" | "cached" | "fallback" }> => {
  const body = unwrapPurchaseBody(data);
  const history = body?.history;
  if (!Array.isArray(history)) return [];
  const provenance = body?.isLive === false || String(body?.source ?? "").includes("fallback") ? "fallback" as const : "live" as const;
  return history.flatMap((point) => {
    if (!point || typeof point !== "object") return [];
    const row = point as Record<string, unknown>;
    const rawT = typeof row.t === "number" ? row.t : typeof row.timestamp === "number" ? row.timestamp : NaN;
    // CoinGecko sometimes returns unix seconds — normalize to ms so event focus lines land on the chart.
    const t = Number.isFinite(rawT) && rawT > 0 && rawT < 1e12 ? rawT * 1000 : rawT;
    const price = typeof row.price === "number" ? row.price : typeof row.close === "number" ? row.close : NaN;
    if (!Number.isFinite(t) || !Number.isFinite(price) || price <= 0) return [];
    return [{ t, price, provenance }];
  });
};

const asOfFromPurchase = (data: unknown, fallbackIso: string): number => {
  const outer = data && typeof data === "object" ? data as Record<string, unknown> : undefined;
  const body = unwrapPurchaseBody(data);
  const raw = body?.lastUpdatedAt ?? outer?.asOf ?? fallbackIso;
  const parsed = typeof raw === "string" || typeof raw === "number" ? Date.parse(String(raw)) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.parse(fallbackIso);
};

const proposalForUi = (trade: import("../store/types.js").PendingTrade, slippageBps: number) => {
  const decimals = trade.proposal.toSymbol.toUpperCase() === "HBAR" ? 8 : 6;
  const expected = trade.quote?.expectedAmountOutFormatted;
  return {
    id: trade.id, status: trade.status, fromSymbol: trade.proposal.fromSymbol, toSymbol: trade.proposal.toSymbol,
    amount: trade.proposal.amountFormatted, expectedOutput: expected,
    expectedRate: expected && trade.proposal.amountFormatted ? expected / trade.proposal.amountFormatted : undefined,
    minimumOutput: trade.builtTransaction ? Number(trade.builtTransaction.amountOutMinimum) / 10 ** decimals : undefined,
    slippageBps, priceImpactBps: trade.quote?.priceImpact === undefined ? undefined : trade.quote.priceImpact * 10_000,
    route: trade.quote?.route, quoteAt: trade.quote?.quotedAt,
    expiresAt: trade.builtTransaction ? new Date(trade.builtTransaction.deadline * 1_000).toISOString() : undefined,
    reason: trade.proposal.reasoning, withinLimits: trade.status === "pending", breach: trade.rejectionReason,
  };
};

const mandateForUi = (mandate: PortfolioMandate | null) => mandate && {
  ...mandate,
  limits: {
    maxPerTrade: mandate.risk.maxTradeUsd ?? mandate.risk.maxTradePct,
    maxTradesPerDay: mandate.risk.maxTradesPerDay,
    maxPortfolioMovePct: mandate.risk.maxPortfolioMovePct ?? mandate.risk.maxTradePct,
    maxDailySpend: mandate.risk.maxDailyDataHbar ?? mandate.risk.maxDailySpend,
    maxSlippageBps: mandate.risk.maxSlippageBps,
    maxPriceImpactBps: mandate.risk.maxPriceImpactBps,
    allowList: mandate.risk.allowList ?? ["HBAR", "USDC", "SAUCE"],
  },
};

export interface CreateAppOptions {
  initializePayments?: boolean;
}

export const createApp = (
  provider: DataProvider,
  config: ServerConfig,
  options: CreateAppOptions = {},
): Hono => {
  const catalog = provider.catalog();
  const app = new Hono();
  const agent = new AgentRunner(config);
  const multiRunner = new MultiAssetAgentRunner(config, provider);
  const inFlightManualRuns = new Map<string, Promise<unknown>>();
  const initializePayments = options.initializePayments ?? true;

  // Initialize scheduler with multi-runner
  agentScheduler.init(multiRunner);

  if (initializePayments && config.agentPayerId && !(store.getState().profiles ?? []).some((profile) => profile.accountId === config.agentPayerId)) {
    const now = new Date().toISOString();
    const profile: PortfolioProfile = {
      id: "agent-managed",
      name: "Autonomous agent",
      kind: "agent_managed",
      accountId: config.agentPayerId,
      network: config.hederaNetwork,
      status: store.getState().schedule.enabled ? "active" : "paused",
      autonomyMode: store.getState().schedule.autonomousTrading ? 4 : 3,
      cadenceMinutes: store.getState().schedule.intervalMinutes,
      createdAt: now,
      updatedAt: now,
    };
    store.upsertProfile(profile);
    const mandate: PortfolioMandate = {
      id: "agent-managed-mandate-v1",
      profileId: profile.id,
      version: 1,
      objective: "Keep HBAR, USDC, and SAUCE within their configured allocation bands.",
      allocations: [
        { symbol: "HBAR", minPct: 25, targetPct: 34, maxPct: 45 },
        { symbol: "USDC", minPct: 25, targetPct: 33, maxPct: 45 },
        { symbol: "SAUCE", minPct: 10, targetPct: 33, maxPct: 40 },
      ],
      risk: { maxTradePct: 5, maxTradesPerDay: 6, maxSlippageBps: Number(config.tradeSlippageBps ?? "100") },
      createdAt: now,
    };
    store.saveMandate(mandate);
  }

  const resolveTradeProfile = (trade: { runId: string; accountId: string }) => {
    const state = store.getState();
    const run = state.runs.find((item) => item.id === trade.runId);
    // Prefer the run's custody profile — shared treasury account IDs must not
    // resolve to agent_managed and auto-sign Mode 3 wallet proposals.
    return (run?.profileId ? store.getProfile(run.profileId) : null)
      ?? (state.activeProfileId ? store.getProfile(state.activeProfileId) : null)
      ?? state.profiles?.find((item) => item.accountId === trade.accountId && item.kind === "user_wallet" && item.status === "active")
      ?? state.profiles?.find((item) => item.accountId === trade.accountId && item.status === "active")
      ?? state.profiles?.find((item) => item.accountId === trade.accountId)
      ?? null;
  };

  const executePendingTrade = async (tradeId: string) => {
    const trade = store.getState().pendingTrades.find((item) => item.id === tradeId && item.status === "pending");
    if (!trade) return { status: 404 as const, body: { error: "Pending trade not found or already evaluated" } };
    const profile = resolveTradeProfile(trade);
    const profileId = profile?.id;
    if (store.isHalted()) return { status: 423 as const, body: { error: "Global kill switch is active" } };
    if (!trade.quote || !trade.builtTransaction) return { status: 409 as const, body: { error: "Trade has no fresh executable SaucerSwap quote" } };
    if (trade.builtTransaction.deadline * 1_000 <= Date.now()) {
      store.updatePendingTrade(tradeId, { status: "expired", rejectionReason: "SaucerSwap quote expired" }, profileId);
      return { status: 409 as const, body: { error: "The executable quote expired; run the agent again for a fresh quote" } };
    }
    // Mode 3 user-wallet custody: browser must sign via WalletConnect — never the server key.
    // Resolve profile via run.profileId first so a shared treasury accountId cannot
    // flip a user-wallet proposal onto the agent signer and clear the approval card.
    const requiresWalletSignature = profile?.kind === "user_wallet"
      || trade.accountId !== config.agentPayerId
      || !config.agentPayerKey;
    if (requiresWalletSignature) {
      const params = trade.builtTransaction.encodedParameters;
      const encodedParameters = Buffer.from(params).toString("base64");
      return {
        status: 202 as const,
        body: {
          status: "needs_wallet_signature",
          message: "Approve this swap in your connected wallet. The server will not sign user-wallet trades.",
          tradeId: trade.id,
          accountId: trade.accountId,
          signing: {
            contractId: trade.builtTransaction.contractId,
            functionName: trade.builtTransaction.functionName,
            encodedParameters,
            amountTinybar: trade.builtTransaction.amountTinybar.toString(),
            deadline: trade.builtTransaction.deadline,
            amountOutMinimum: trade.builtTransaction.amountOutMinimum.toString(),
            route: trade.builtTransaction.route,
            quote: {
              fromSymbol: trade.quote.fromSymbol,
              toSymbol: trade.quote.toSymbol,
              fromToken: trade.quote.fromToken,
              toToken: trade.quote.toToken,
              amountIn: trade.quote.amountIn.toString(),
              expectedAmountOut: trade.quote.expectedAmountOut.toString(),
              amountInFormatted: trade.quote.amountInFormatted,
            },
          },
        },
      };
    }
    // Persist the one-way authorization transition before touching the network.
    // A timeout after Hedera consensus must never make the same proposal retryable.
    const agentKey = config.agentPayerKey;
    if (!agentKey) return { status: 503 as const, body: { error: "Agent signer is not configured" } };
    store.updatePendingTrade(tradeId, { status: "approved" }, profileId);
    let result;
    try {
      result = await executeSaucerSwap({
        payerId: trade.accountId,
        payerKey: agentKey,
        quote: trade.quote,
        transaction: trade.builtTransaction,
        mirrorBaseUrl: config.mirrorNodeBaseUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "SaucerSwap execution failed";
      store.updatePendingTrade(tradeId, { status: "rejected", rejectionReason: message }, profileId);
      throw error;
    }
    const updated = store.updatePendingTrade(tradeId, { status: "approved", executionResult: result }, profileId);
    const run = store.getState().runs.find((item) => item.id === trade.runId);
    let portfolioAfter = run?.portfolioAfter;
    if (run?.portfolioBefore) {
      try {
        const afterRaw = await readPortfolio(trade.accountId, { mirrorBaseUrl: config.mirrorNodeBaseUrl });
        const prices = pricesUsdFromPortfolio(run.portfolioBefore);
        const managed = ["HBAR", "USDC", "SAUCE"].map((symbol) => afterRaw.allocations.find((item) => item.symbol.toUpperCase() === symbol) ?? {
          symbol,
          balanceFormatted: 0,
          usdValue: 0,
          allocationPct: 0,
        });
        portfolioAfter = valuePortfolio({ ...afterRaw, allocations: managed }, prices);
      } catch {
        portfolioAfter = undefined;
      }
    }
    if (run) {
      store.updateRun(run.id, {
        status: "completed",
        tradeExecutions: [...run.tradeExecutions, result],
        ...(portfolioAfter ? { portfolioAfter } : {}),
      }, profileId);
    }
    store.recordSpend(0, trade.proposal.amountFormatted, profileId);
    sseBroadcaster.broadcast("trade.verified", { tradeId, result }, { profileId, runId: trade.runId, provenance: "live" });
    if (portfolioAfter) {
      sseBroadcaster.broadcast("portfolio.updated", {
        tradeId,
        portfolio: portfolioAfter,
        title: "Portfolio refreshed after the swap",
        detail: "Balances and mix updated from live holdings.",
      }, { profileId, runId: trade.runId, provenance: "live" });
    }
    return { status: 200 as const, body: { status: "approved", trade: updated, execution: result } };
  };

  const routes: RoutesConfig = {
    "GET /data/:product": {
      description: "Financial market data — price and params vary by product",
      accepts: {
        scheme: "exact",
        network: config.hederaNetwork as Network,
        payTo: config.payToAccount,
        price: (ctx) => priceForProduct(catalog, productIdFromPath(ctx.path)),
        maxTimeoutSeconds: 180,
      },
    },
  };

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.use("/api/*", cors({
    origin: (origin) => {
      if (!origin) return "";
      if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL;
      return origin; // Allow any origin if FRONTEND_URL is not strictly set, useful for Vercel preview deployments.
    },
    credentials: true,
    allowHeaders: ["Content-Type", "Last-Event-ID", "Idempotency-Key"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }));

  app.get("/api/health", (c) => c.json({
    status: "ok",
    network: config.hederaNetwork,
    providerId: provider.id,
    agent: {
      paymentReady: agent.isPaymentReady(),
      mistralReady: Boolean(config.mistralApiKey),
    },
    store: {
      account: store.getState().account,
      schedule: store.getState().schedule,
      runsCount: store.getState().runs.length,
      pendingTradesCount: store.getState().pendingTrades.filter((t) => t.status === "pending").length,
    },
  }));

  // --- Versioned Dino Agent API ---

  app.get("/api/v1/profiles", (c) => {
    const schedule = store.getState().schedule;
    const state = store.getState();
    const profiles = (state.profiles ?? []).map((profile) => {
      if (profile.kind !== "agent_managed") return profile;
      return {
        ...profile,
        cadenceMinutes: profile.cadenceMinutes ?? schedule.intervalMinutes,
        // Do not force paused from the global scheduler — user-wallet pause must not hide the agent.
        autonomyMode: schedule.autonomousTrading ? 4 as const : (profile.autonomyMode ?? 3),
      };
    });
    return c.json(jsonSafe({
      profiles,
      activeProfileId: state.activeProfileId ?? resolveActiveProfile(state)?.id ?? null,
      account: state.account,
    }));
  });

  app.post("/api/v1/profiles/:profileId/clear", (c) => {
    const profile = store.getProfile(c.req.param("profileId"));
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    try {
      const result = store.clearProfileSession(profile.id);
      sseBroadcaster.broadcast("session.cleared", { profileId: profile.id, ...result }, { profileId: profile.id });
      return c.json({ ok: true, profileId: profile.id, ...result });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to clear session" }, 400);
    }
  });

  app.delete("/api/v1/profiles/:profileId", (c) => {
    const profileId = c.req.param("profileId");
    try {
      const removed = store.removeProfile(profileId);
      if (!removed) return c.json({ error: "Profile not found" }, 404);
      sseBroadcaster.broadcast("session.removed", { profileId });
      return c.json({ ok: true, profileId });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to remove session" }, 400);
    }
  });

  app.post("/api/v1/profiles/:profileId/activate", (c) => {
    const profile = store.getProfile(c.req.param("profileId"));
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    const now = new Date().toISOString();
    for (const other of store.getState().profiles ?? []) {
      if (other.id === profile.id) continue;
      if (other.status === "active") {
        store.upsertProfile({ ...other, status: "paused", updatedAt: now });
      }
    }
    const activated = store.upsertProfile({ ...profile, status: "active", updatedAt: now });
    store.setActiveProfileId(activated.id);
    // Resuming a session should always clear a leftover kill switch so Send works again.
    if (store.isHalted()) store.setSystemHalt(false);
    if (activated.kind === "user_wallet") {
      store.setAccount({
        accountId: activated.accountId,
        label: activated.name,
        connectedAt: now,
      });
      store.updateSchedule({
        enabled: (activated.autonomyMode ?? 1) >= 2,
        autonomousTrading: false,
      });
      if ((activated.autonomyMode ?? 1) >= 2) agentScheduler.start();
      else agentScheduler.stop();
    } else {
      store.updateSchedule({
        enabled: true,
        autonomousTrading: (activated.autonomyMode ?? 4) === 4,
      });
      agentScheduler.start();
    }
    sseBroadcaster.broadcast("session.activated", { profileId: activated.id }, { profileId: activated.id });
    return c.json(jsonSafe({ profile: activated, activeProfileId: activated.id }));
  });

  app.get("/api/v1/profiles/:profileId", (c) => {
    const profile = store.getProfile(c.req.param("profileId"));
    return profile ? c.json(profile) : c.json({ error: "Profile not found" }, 404);
  });

  app.get("/api/v1/profiles/:profileId/mandate", (c) => {
    const profile = store.getProfile(c.req.param("profileId"));
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    const mandate = store.getLatestMandate(profile.id);
    return mandate ? c.json(jsonSafe(mandateForUi(mandate))) : c.json({ error: "No mandate configured" }, 404);
  });

  app.patch("/api/v1/profiles/:profileId/mandate", async (c) => {
    const profile = store.getProfile(c.req.param("profileId"));
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    const patch = await c.req.json<Partial<Pick<PortfolioMandate, "objective" | "allocations" | "risk">>>().catch(() => null);
    if (!patch) return c.json({ error: "Request body must be valid JSON" }, 400);
    const previous = store.getLatestMandate(profile.id);
    const allocations = patch.allocations ?? previous?.allocations;
    if (!allocations) return c.json({ error: "Allocation bands are required for the first mandate" }, 400);
    try { validateAllocationBands(allocations); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid allocation bands" }, 400); }
    const mandate: PortfolioMandate = {
      id: crypto.randomUUID(), profileId: profile.id, version: (previous?.version ?? 0) + 1,
      objective: typeof patch.objective === "string" ? patch.objective.trim().slice(0, 600) : previous?.objective,
      allocations, risk: { ...(previous?.risk ?? {}), ...(patch.risk ?? {}) }, createdAt: new Date().toISOString(),
    };
    store.saveMandate(mandate);
    store.upsertProfile({ ...profile, mandateId: mandate.id, updatedAt: mandate.createdAt });
    sseBroadcaster.broadcast("mandate.saved", mandate, { profileId: profile.id });
    return c.json(jsonSafe(mandateForUi(mandate)));
  });

  app.get("/api/v1/profiles/:profileId/dashboard", async (c) => {
    const profile = store.getProfile(c.req.param("profileId"));
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    const state = store.getState();
    const hasPendingTrade = (runId: string) => state.pendingTrades.some((trade) => trade.runId === runId && trade.status === "pending");
    const runsForProfile = (run: typeof state.runs[number]) => {
      if (run.accountId !== profile.accountId) return false;
      // Prefer explicit profile ownership so agent/user rails stay separate when
      // both profiles share the same Hedera account id.
      if (run.profileId) return run.profileId === profile.id;
      // Legacy unscoped rows: keep only truly in-flight work.
      if (run.status === "running") return true;
      return run.status === "waiting_approval" && hasPendingTrade(run.id);
    };
    const runs = state.runs.filter(runsForProfile).map((run) => run.status === "waiting_approval" && !hasPendingTrade(run.id) ? { ...run, status: "completed" as const } : run);
    const latestValued = runs.find((run) => run.portfolioAfter)?.portfolioAfter
      ?? runs.find((run) => run.portfolioBefore)?.portfolioBefore;
    const pending = state.pendingTrades.filter((trade) => trade.accountId === profile.accountId && trade.status === "pending");
    const events = store.replayEvents(undefined, profile.id).filter(isUserFacingEvent).map(eventForUi);
    const schedule = { cadenceMinutes: state.schedule.intervalMinutes, paused: !state.schedule.enabled, nextRunAt: state.schedule.nextRunAt, lastRunAt: runs[0]?.startedAt, autonomyMode: profile.autonomyMode ?? 3 };

    let portfolio: {
      accountId: string;
      asOf: string;
      totalUsd: number;
      provenance: string;
      assets: Array<{ symbol: string; balance: number; usdValue: number; allocationPct: number; provenance: string }>;
      valued: boolean;
    } | null = null;
    try {
      const live = await readPortfolio(profile.accountId, { mirrorBaseUrl: config.mirrorNodeBaseUrl });
      // Always refresh display USD marks on dashboard load. Stale run marks (or a
      // bad paid SAUCE print) must not freeze the sidebar total vs Mirror qty.
      const display = await fetchDisplayUsdPrices(live.allocations.map((asset) => asset.symbol));
      const merged = mergeLivePortfolioValuation(
        live,
        latestValued,
        display.prices,
        Object.keys(display.prices).length > 0 ? `display:${display.provenance}` : undefined,
      );
      portfolio = {
        accountId: live.accountId,
        asOf: live.fetchedAt,
        totalUsd: merged.totalUsd,
        provenance: merged.provenance,
        assets: merged.assets,
        valued: merged.valued,
      };
    } catch (error) {
      console.warn(`[dashboard] live portfolio read failed for ${profile.accountId}:`, error instanceof Error ? error.message : error);
      if (latestValued) {
        const totalUsd = latestValued.totalUsdValue ?? 0;
        portfolio = {
          accountId: latestValued.accountId,
          asOf: latestValued.fetchedAt,
          totalUsd,
          provenance: latestValued.provenance,
          assets: latestValued.allocations.map((asset) => ({
            symbol: asset.symbol,
            balance: asset.balanceFormatted,
            usdValue: asset.usdValue,
            allocationPct: asset.allocationPct,
            provenance: latestValued.provenance,
          })),
          valued: totalUsd > 0,
        };
      }
    }

    return c.json(jsonSafe({ profile, mandate: mandateForUi(store.getLatestMandate(profile.id)), schedule, portfolio, runs, events,
      pendingProposals: pending.map((trade) => proposalForUi(trade, Number(config.tradeSlippageBps ?? "100"))),
      spend: { dataHbar: state.spending.totalDataHbar, tradeHbar: state.spending.totalTradeHbar, dataTodayHbar: state.spending.todayDataHbar, tradeTodayHbar: state.spending.todayTradeHbar },
      system: state.system ?? { halted: false },
    }));
  });

  app.get("/api/v1/profiles/:profileId/graph", (c) => {
    const profile = store.getProfile(c.req.param("profileId"));
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    const series = (c.req.query("series") ?? "portfolio").toUpperCase();
    const runs = store.getState().runs.filter((run) => run.accountId === profile.accountId).slice().reverse();
    const weights = runs.flatMap((run) => {
      const portfolio = run.portfolioAfter ?? run.portfolioBefore;
      const hbar = portfolio?.allocations?.find((allocation) => allocation.symbol.toUpperCase() === "HBAR");
      if (typeof hbar?.allocationPct !== "number") return [];
      return [{ t: Date.parse(run.completedAt ?? run.startedAt), weight: hbar.allocationPct }];
    });
    const ticks = runs.flatMap((run) => {
      const portfolio = run.portfolioAfter ?? run.portfolioBefore;
      if (series === "PORTFOLIO") return typeof portfolio?.totalUsdValue === "number" ? [{ t: Date.parse(portfolio.fetchedAt), price: portfolio.totalUsdValue, value: portfolio.totalUsdValue, provenance: portfolio.provenance }] : [];
      // Prefer CoinGecko history bundled with paid reads; fall back to spot samples.
      return run.dataPurchases
        .filter((purchase) => purchase.symbol.toUpperCase() === series)
        .flatMap((purchase) => {
          const history = historyFromPurchase(purchase.data);
          const spot = priceFromPurchase(purchase.data);
          const at = asOfFromPurchase(purchase.data, run.completedAt ?? run.startedAt);
          const body = unwrapPurchaseBody(purchase.data);
          const provenance = body?.isLive === false || String(body?.source ?? "").includes("fallback")
            ? "fallback" as const
            : purchase.transactionId.startsWith("cache:")
              ? "cached" as const
              : "live" as const;
          const spots = spot === undefined ? [] : [{ t: at, price: spot, value: spot, provenance }];
          return [
            ...history.map((point) => ({ t: point.t, price: point.price, value: point.price, provenance: point.provenance })),
            ...spots,
          ];
        });
    });
    // Also lift priced SSE observations (cache reuse) so the chart keeps moving between paid buys.
    const observationTicks = store.replayEvents(undefined, profile.id).map(eventForUi).flatMap((event) => {
      if (event.kind !== "data.received" && event.kind !== "payment.settled") return [];
      const payload = event.payload as Record<string, unknown> | undefined;
      const price = typeof payload?.price === "number" ? payload.price : undefined;
      const symbol = typeof payload?.symbol === "string" ? payload.symbol.toUpperCase() : "";
      if (price === undefined || !Number.isFinite(price) || (symbol && symbol !== series)) return [];
      // Titles like "HBAR payment verified" / "HBAR intelligence reused" when symbol missing.
      if (!symbol && !(event.title ?? "").toUpperCase().startsWith(series)) return [];
      const provenance = event.provenance === "stale" ? "fallback" as const : (event.provenance === "cached" ? "cached" as const : "live" as const);
      return [{ t: Date.parse(event.occurredAt ?? ""), price, value: price, provenance }];
    });
    const merged = [...ticks, ...observationTicks];
    // Deduplicate same-timestamp ticks; keep denser CoinGecko history intact.
    const deduped = [...new Map(merged.map((tick) => [`${tick.t}:${tick.price}`, tick])).values()].sort((a, b) => a.t - b.t);
    const markers = store.replayEvents(undefined, profile.id).map(eventForUi)
      .filter((event) => ["payment.settled", "trade.proposed", "trade.submitted", "trade.verified"].includes(event.kind))
      .map((event) => ({ t: Date.parse(event.occurredAt ?? ""), eventId: event.id, kind: event.kind, label: event.title, provenance: event.provenance }));
    return c.json(jsonSafe({
      series: series === "PORTFOLIO" ? "portfolio" : series,
      ticks: deduped,
      markers,
      weights,
      source: deduped.length > 2 ? "coingecko-history+spot" : deduped.length > 0 ? "paid-spot" : "empty",
    }));
  });

  app.get("/api/v1/profiles/:profileId/receipts", (c) => {
    const profile = store.getProfile(c.req.param("profileId"));
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    const receipts = store.getState().runs.filter((run) => run.accountId === profile.accountId).flatMap((run) => [
      ...run.dataPurchases
        .filter((purchase) => !purchase.transactionId.startsWith("cache:") && purchase.amountHbar > 0)
        .map((purchase) => ({ id: `data:${run.id}:${purchase.transactionId}`, kind: "data_purchase", runId: run.id, occurredAt: run.completedAt ?? run.startedAt, status: "confirmed", asset: "HBAR", amountHbar: purchase.amountHbar, productId: purchase.productId, symbol: purchase.symbol, transactionId: purchase.transactionId, hashscanUrl: purchase.hashscanUrl, provenance: "live" })),
      ...run.tradeExecutions.map((trade) => ({ id: `trade:${trade.transactionId}`, kind: "trade", runId: run.id, occurredAt: run.completedAt ?? run.startedAt, status: trade.success ? "confirmed" : "failed", transactionId: trade.transactionId, hashscanUrl: trade.hashscanUrl, fromSymbol: trade.fromSymbol, toSymbol: trade.toSymbol, amountIn: trade.amountIn, amountOut: trade.amountOut, provenance: "live" })),
    ]);
    return c.json(jsonSafe({ receipts }));
  });

  app.get("/api/v1/profiles/:profileId/portfolio", async (c) => {
    const profile = store.getProfile(c.req.param("profileId"));
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    try {
      const latestValued = store.getState().runs.find((run) => run.accountId === profile.accountId && run.portfolioAfter)?.portfolioAfter
        ?? store.getState().runs.find((run) => run.accountId === profile.accountId && run.portfolioBefore)?.portfolioBefore;
      try {
        const live = await readPortfolio(profile.accountId, { mirrorBaseUrl: config.mirrorNodeBaseUrl });
        const display = await fetchDisplayUsdPrices(live.allocations.map((asset) => asset.symbol));
        const merged = mergeLivePortfolioValuation(
          live,
          latestValued,
          display.prices,
          Object.keys(display.prices).length > 0 ? `display:${display.provenance}` : undefined,
        );
        return c.json(jsonSafe({
          accountId: profile.accountId,
          asOf: live.fetchedAt,
          totalUsd: merged.totalUsd,
          provenance: merged.provenance,
          assets: merged.assets,
          valued: merged.valued,
        }));
      } catch (liveError) {
        console.warn(`[portfolio] Mirror read failed for ${profile.accountId}:`, liveError instanceof Error ? liveError.message : liveError);
        if (latestValued) {
          return c.json(jsonSafe({
            accountId: profile.accountId,
            asOf: latestValued.fetchedAt,
            totalUsd: latestValued.totalUsdValue,
            provenance: latestValued.provenance,
            assets: latestValued.allocations.map((asset) => ({
              symbol: asset.symbol,
              balance: asset.balanceFormatted,
              usdValue: asset.usdValue,
              allocationPct: asset.allocationPct,
              provenance: latestValued.provenance,
            })),
            valued: (latestValued.totalUsdValue ?? 0) > 0,
          }));
        }
        // Unknown / deleted test accounts should not 503 the whole workspace.
        return c.json(jsonSafe({
          accountId: profile.accountId,
          asOf: new Date().toISOString(),
          totalUsd: 0,
          provenance: "live",
          assets: [],
          valued: false,
          error: "Mirror has no balances for this account yet.",
        }));
      }
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to read portfolio" }, 503);
    }
  });

  app.get("/api/v1/profiles/:profileId/runs", (c) => {
    const profile = store.getProfile(c.req.param("profileId"));
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    const state = store.getState();
    const hasPendingTrade = (runId: string) => state.pendingTrades.some((trade) => trade.runId === runId && trade.status === "pending");
    const runs = state.runs
      .filter((run) => {
        if (run.accountId !== profile.accountId) return false;
        if (run.profileId) return run.profileId === profile.id;
        if (run.status === "running") return true;
        return run.status === "waiting_approval" && hasPendingTrade(run.id);
      })
      .map((run) => run.status === "waiting_approval" && !hasPendingTrade(run.id) ? { ...run, status: "completed" as const } : run);
    const events = store.replayEvents(undefined, profile.id).map(eventForUi);
    return c.json(jsonSafe({ runs, events }));
  });

  app.post("/api/v1/profiles/:profileId/runs", async (c) => {
    const profile = store.getProfile(c.req.param("profileId"));
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    if (store.isHalted()) return c.json({ error: "Global kill switch is active" }, 423);
    const body = await c.req.json<{ objective?: string }>().catch((): { objective?: string } => ({}));
    if (body.objective !== undefined && (typeof body.objective !== "string" || body.objective.trim().length > 600)) return c.json({ error: "Objective must be at most 600 characters" }, 400);
    const idempotencyKey = c.req.header("idempotency-key");
    if (idempotencyKey !== undefined && (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey))) return c.json({ error: "Idempotency-Key must be 8-200 safe characters" }, 400);
    if (idempotencyKey) {
      const existing = store.findRunByIdempotency(profile.accountId, idempotencyKey);
      if (existing) return c.json(jsonSafe(existing));
      const inFlight = inFlightManualRuns.get(`${profile.id}:${idempotencyKey}`);
      if (inFlight) return c.json(jsonSafe(await inFlight));
    }
    try {
      const key = idempotencyKey ? `${profile.id}:${idempotencyKey}` : undefined;
      const work = agentScheduler.triggerManualRun(profile.accountId, { objective: body.objective, idempotencyKey, profileId: profile.id }) as Promise<Awaited<ReturnType<MultiAssetAgentRunner["runMultiAsset"]>>>;
      if (key) inFlightManualRuns.set(key, work);
      const result = await work;
      if (key) inFlightManualRuns.delete(key);
      return c.json(jsonSafe(result), 200);
    } catch (error) {
      if (idempotencyKey) inFlightManualRuns.delete(`${profile.id}:${idempotencyKey}`);
      return c.json({ error: error instanceof Error ? error.message : "Unable to start run" }, 500);
    }
  });

  app.get("/api/v1/profiles/:profileId/proposals", (c) => {
    const profile = store.getProfile(c.req.param("profileId"));
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    const now = Date.now();
    const pendingTrades = store.getState().pendingTrades.filter((trade) => trade.accountId === profile.accountId && trade.status === "pending");
    for (const trade of pendingTrades) {
      if (trade.builtTransaction && trade.builtTransaction.deadline * 1_000 <= now) {
        store.updatePendingTrade(trade.id, { status: "expired", rejectionReason: "SaucerSwap quote expired" });
      }
    }
    const proposals = store.getState().pendingTrades
      .filter((trade) => trade.accountId === profile.accountId && trade.status === "pending")
      .map((trade) => proposalForUi(trade, Number(config.tradeSlippageBps ?? "100")));
    return c.json(jsonSafe({ proposals }));
  });

  app.patch("/api/v1/profiles/:profileId/schedule", async (c) => {
    const profile = store.getProfile(c.req.param("profileId"));
    if (!profile) return c.json({ error: "Profile not found" }, 404);
    const body = await c.req.json<{ cadenceMinutes?: number; paused?: boolean; autonomousTrading?: boolean; autonomyMode?: 1 | 2 | 3 | 4 }>().catch(() => null);
    if (!body) return c.json({ error: "Request body must be valid JSON" }, 400);
    const requestedMode = body.autonomyMode ?? (body.autonomousTrading === undefined ? profile.autonomyMode ?? 3 : body.autonomousTrading ? 4 : 3);
    if (!Number.isInteger(requestedMode) || requestedMode < 1 || requestedMode > 4) return c.json({ error: "Autonomy mode must be 1, 2, 3, or 4" }, 400);
    if (requestedMode === 4 && profile.kind !== "agent_managed") return c.json({ error: "Autonomous signing is available only for the dedicated agent profile" }, 403);
    const cadence = body.cadenceMinutes ?? store.getState().schedule.intervalMinutes;
    if (!Number.isInteger(cadence) || cadence < 1 || cadence > 1_440) return c.json({ error: "Cadence must be 1-1440 minutes" }, 400);
    const enabled = body.paused === undefined
      ? (profile.kind === "agent_managed" ? store.getState().schedule.enabled : profile.status === "active")
      : !body.paused;
    if (profile.kind === "agent_managed") {
      store.updateSchedule({ intervalMinutes: cadence, enabled, autonomousTrading: requestedMode === 4 });
      if (enabled) agentScheduler.start(); else agentScheduler.stop();
    }
    const updated = { ...profile, cadenceMinutes: cadence, autonomyMode: requestedMode as 1 | 2 | 3 | 4, status: enabled ? "active" as const : "paused" as const, updatedAt: new Date().toISOString() };
    store.upsertProfile(updated);
    sseBroadcaster.broadcast("profile.schedule.updated", { profileId: profile.id, cadenceMinutes: cadence, paused: !enabled, autonomyMode: requestedMode }, { profileId: profile.id });
    return c.json({ cadenceMinutes: cadence, paused: !enabled, autonomousTrading: store.getState().schedule.autonomousTrading, autonomyMode: requestedMode });
  });

  app.get("/api/v1/profiles/:profileId/stream", (c) => streamSSE(c, async (stream) => {
    const profileId = c.req.param("profileId");
    if (!store.getProfile(profileId)) {
      await stream.writeSSE({ event: "error", data: JSON.stringify({ error: "Profile not found" }) });
      return;
    }
    const clientId = crypto.randomUUID();
    const send = (data: string) => { void stream.write(data); };
    sseBroadcaster.replay(send, c.req.header("last-event-id"), profileId);
    const remove = sseBroadcaster.addClient(clientId, send, profileId);
    stream.onAbort(remove);
    await stream.writeSSE({ event: "snapshot", data: JSON.stringify({ profileId }) });
    try {
      while (true) {
        await stream.sleep(15_000);
        await stream.writeSSE({ event: "ping", data: JSON.stringify({ at: new Date().toISOString() }) });
      }
    } finally {
      remove();
    }
  }));

  app.get("/api/v1/system/state", (c) => c.json(store.getState().system ?? { halted: false }));
  app.post("/api/v1/system/halt", (c) => {
    store.setSystemHalt(true, "Operator halt");
    agentScheduler.stop();
    for (const trade of store.getState().pendingTrades.filter((item) => item.status === "pending")) {
      store.updatePendingTrade(trade.id, { status: "expired", rejectionReason: "Global kill switch" });
    }
    return c.json(store.getState().system);
  });
  app.post("/api/v1/system/resume", (c) => {
    store.setSystemHalt(false);
    if (store.getState().schedule.enabled) agentScheduler.start();
    return c.json(store.getState().system);
  });

  app.post("/api/v1/proposals/:id/approve", async (c) => {
    try {
      const result = await executePendingTrade(c.req.param("id"));
      return c.json(jsonSafe(result.body), result.status);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Approval execution failed" }, 502);
    }
  });

  async function confirmTradeInternal(tradeId: string, transactionId: string) {
    const trade = store.getState().pendingTrades.find((item) => item.id === tradeId && item.status === "pending");
    if (!trade) return null;
    const profileId = store.getState().profiles?.find((profile) => profile.accountId === trade.accountId)?.id;
    const result = {
      success: true,
      transactionId,
      hashscanUrl: `https://hashscan.io/testnet/transaction/${transactionId}`,
      fromToken: trade.quote?.fromToken ?? "",
      fromSymbol: trade.proposal.fromSymbol,
      toToken: trade.quote?.toToken ?? "",
      toSymbol: trade.proposal.toSymbol,
      amountIn: trade.quote?.amountIn ?? 0n,
      amountInFormatted: trade.proposal.amountFormatted,
    };
    store.updatePendingTrade(trade.id, { status: "approved", executionResult: result }, profileId);
    const run = store.getState().runs.find((item) => item.id === trade.runId);
    let portfolioAfter = run?.portfolioAfter;
    if (run?.portfolioBefore) {
      try {
        const afterRaw = await readPortfolio(trade.accountId, { mirrorBaseUrl: config.mirrorNodeBaseUrl });
        const prices = pricesUsdFromPortfolio(run.portfolioBefore);
        const managed = ["HBAR", "USDC", "SAUCE"].map((symbol) => afterRaw.allocations.find((item) => item.symbol.toUpperCase() === symbol) ?? {
          symbol,
          balanceFormatted: 0,
          usdValue: 0,
          allocationPct: 0,
        });
        portfolioAfter = valuePortfolio({ ...afterRaw, allocations: managed }, prices);
      } catch {
        portfolioAfter = undefined;
      }
    }
    if (run) {
      store.updateRun(run.id, {
        status: "completed",
        tradeExecutions: [...run.tradeExecutions, result],
        completedAt: new Date().toISOString(),
        ...(portfolioAfter ? { portfolioAfter } : {}),
      }, profileId);
    }
    store.recordSpend(0, trade.proposal.amountFormatted, profileId);
    const verifiedEventPayload = {
      presentInUi: true,
      title: "Swap completed in your wallet",
      detail: `Your wallet confirmed the exchange.`,
      tradeId: trade.id,
      result,
      transactionId,
    };
    store.appendEvent("trade.verified", verifiedEventPayload, { profileId, runId: trade.runId, provenance: "live" });
    sseBroadcaster.broadcast("trade.verified", verifiedEventPayload, { profileId, runId: trade.runId, provenance: "live" });

    if (portfolioAfter) {
      const portfolioEventPayload = {
        presentInUi: true,
        title: "Portfolio refreshed after the swap",
        detail: "Balances and mix updated from live holdings.",
        tradeId: trade.id,
        portfolio: portfolioAfter,
      };
      store.appendEvent("portfolio.updated", portfolioEventPayload, { profileId, runId: trade.runId, provenance: "live" });
      sseBroadcaster.broadcast("portfolio.updated", portfolioEventPayload, { profileId, runId: trade.runId, provenance: "live" });
    }
    return { status: "confirmed", tradeId: trade.id, execution: result };
  }

  // Background poller: Server-side auto-verifier for pending user-wallet trades.
  // Detects when the user completes the transaction in HashPack on-chain without relying on fragile browser WalletConnect callbacks.
  setInterval(async () => {
    const pending = store.getState().pendingTrades.filter((t) => t.status === "pending");
    if (pending.length === 0) return;
    for (const trade of pending) {
      try {
        const createdAtMs = new Date(trade.createdAt).getTime();
        const url = `${config.mirrorNodeBaseUrl}/api/v1/transactions?account.id=${encodeURIComponent(trade.accountId)}&limit=10&order=desc`;
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) continue;
        const data = await res.json() as {
          transactions?: Array<{
            transaction_id?: string;
            consensus_timestamp?: string;
            valid_start_timestamp?: string;
            result?: string;
            name?: string;
          }>;
        };
        const found = data.transactions?.find((tx) => {
          if (tx.result !== "SUCCESS") return false;
          const validSec = tx.valid_start_timestamp
            ? parseFloat(tx.valid_start_timestamp)
            : tx.consensus_timestamp
              ? parseFloat(tx.consensus_timestamp)
              : 0;
          if (validSec * 1000 < createdAtMs - 60_000) return false;
          return tx.name === "CONTRACTCALL" || tx.name === "CRYPTOTRANSFER" || tx.name === "CONTRACTCREATEINSTANCE";
        });
        if (found && found.transaction_id) {
          const formattedTxId = found.transaction_id.includes("-")
            ? found.transaction_id.replace("-", "@").replace(/-([^-]+)$/, ".$1")
            : found.transaction_id;
          console.log(`[server-autoverifier] Automatically verified on-chain trade ${trade.id} via Mirror Node (${formattedTxId})`);
          await confirmTradeInternal(trade.id, formattedTxId);
        }
      } catch {
        // Ignore background polling network glitches
      }
    }
  }, 3000);

  app.post("/api/v1/proposals/:id/confirm", async (c) => {
    try {
      const trade = store.getState().pendingTrades.find((item) => item.id === c.req.param("id") && item.status === "pending");
      if (!trade) return c.json({ error: "Pending trade not found or already evaluated" }, 404);
      const body = await c.req.json<{ transactionId?: string }>().catch(() => null);
      const transactionId = body?.transactionId?.trim();
      if (!transactionId || !transactionId.includes("@")) {
        return c.json({ error: "A Hedera transactionId is required" }, 400);
      }
      const res = await confirmTradeInternal(trade.id, transactionId);
      if (!res) return c.json({ error: "Trade confirm failed" }, 400);
      return c.json(jsonSafe({ status: "confirmed", tradeId: trade.id, execution: res.execution }));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Confirm failed" }, 502);
    }
  });

  app.post("/api/v1/proposals/:id/reject", (c) => {
    const pending = store.getState().pendingTrades.find((item) => item.id === c.req.param("id"));
    const profileId = pending
      ? store.getState().profiles?.find((profile) => profile.accountId === pending.accountId)?.id
      : undefined;
    const trade = store.updatePendingTrade(c.req.param("id"), { status: "rejected", rejectionReason: "User rejected trade" }, profileId);
    if (!trade) return c.json({ error: "Pending trade not found" }, 404);
    const run = store.getState().runs.find((item) => item.id === trade.runId);
    if (run && !store.getState().pendingTrades.some((item) => item.runId === trade.runId && item.status === "pending")) {
      store.updateRun(run.id, { status: "completed", completedAt: run.completedAt ?? new Date().toISOString() }, profileId);
    }
    // One curated card only — updatePendingTrade already writes an audit event that is not shown.
    sseBroadcaster.broadcast("trade.rejected", {
      presentInUi: true,
      tradeId: trade.id,
      title: "Trade declined",
      detail: "You declined this proposal. No transaction was submitted.",
    }, { profileId, runId: trade.runId });
    return c.json({ status: "rejected", trade: jsonSafe(trade) });
  });

  // --- Portfolio & Account Endpoints ---

  app.get("/api/portfolio/:accountId", async (c) => {
    const accountId = c.req.param("accountId");
    try {
      const portfolio = await readPortfolio(accountId);
      return c.json(portfolio);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to fetch portfolio" }, 400);
    }
  });

  app.post("/api/account/connect", async (c) => {
    try {
      const body = await c.req.json<{ accountId: string; label?: string }>();
      if (!body.accountId || !/^0\.0\.\d+$/.test(body.accountId)) {
        return c.json({ error: "Invalid Hedera account ID format (0.0.XXXX)" }, 400);
      }
      const now = new Date().toISOString();
      const account = {
        accountId: body.accountId,
        label: body.label ?? `Wallet ${body.accountId}`,
        connectedAt: now,
      };
      store.setAccount(account);

      const profileId = userWalletProfileId(body.accountId);
      const existing =
        store.getProfile(profileId) ??
        (store.getProfile("connected-wallet")?.accountId === body.accountId
          ? store.getProfile("connected-wallet")
          : null);

      // Pause every other custody session so this wallet becomes the active one.
      for (const other of store.getState().profiles ?? []) {
        if (other.id === profileId || other.id === "connected-wallet") continue;
        if (other.status === "active") {
          store.upsertProfile({ ...other, status: "paused", updatedAt: now });
        }
      }

      const profile: PortfolioProfile = {
        id: profileId,
        name: body.label ?? `Wallet ${body.accountId}`,
        kind: "user_wallet",
        accountId: body.accountId,
        network: config.hederaNetwork,
        status: "paused",
        // Connect always restarts onboarding; autonomy is chosen in /api/v1/onboarding/complete.
        autonomyMode: existing?.autonomyMode ?? 1,
        cadenceMinutes: existing?.cadenceMinutes ?? store.getState().schedule.intervalMinutes,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(existing?.mandateId ? { mandateId: existing.mandateId } : {}),
      };
      store.upsertProfile(profile);
      // Keep the legacy connected-wallet row synced for older readers.
      store.upsertProfile({
        ...profile,
        id: "connected-wallet",
        name: body.label ?? "Connected wallet",
      });
      store.setActiveProfileId(profileId);
      if (!store.getLatestMandate(profile.id)) {
        store.saveMandate({
          id: `${profile.id}-mandate-v1`,
          profileId: profile.id,
          version: 1,
          objective: "Observe the connected wallet and propose rebalances within allocation bands.",
          allocations: [
            { symbol: "HBAR", minPct: 25, targetPct: 34, maxPct: 45 },
            { symbol: "USDC", minPct: 25, targetPct: 33, maxPct: 45 },
            { symbol: "SAUCE", minPct: 10, targetPct: 33, maxPct: 40 },
          ],
          risk: { maxTradePct: 5, maxTradesPerDay: 6, maxSlippageBps: Number(config.tradeSlippageBps ?? "100") },
          createdAt: now,
        });
      }

      return c.json({ ...account, profileId: profile.id, needsOnboarding: true });
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
  });

  app.post("/api/account/disconnect", (c) => {
    const state = store.getState();
    const account = state.account;
    const now = new Date().toISOString();
    const active = resolveActiveProfile(state);
    for (const profile of state.profiles ?? []) {
      if (profile.kind !== "user_wallet") continue;
      if (account && profile.accountId !== account.accountId) continue;
      if (profile.status === "active" || profile.id === "connected-wallet" || profile.id === active?.id) {
        store.upsertProfile({ ...profile, status: "paused", updatedAt: now });
      }
    }
    store.clearAccount();
    if (!active || active.kind === "user_wallet") {
      store.setActiveProfileId(null);
    }
    sseBroadcaster.broadcast("account.disconnected", { accountId: account?.accountId ?? null });
    return c.json({ disconnected: true, accountId: account?.accountId ?? null });
  });

  app.get("/api/account", (c) => c.json(store.getState().account));

  app.get("/api/v1/onboarding", async (c) => {
    const state = store.getState();
    const account = state.account;
    const userWallet = findUserWalletForAccount(state, account?.accountId);
    const agentProfile = (state.profiles ?? []).find((profile) => profile.kind === "agent_managed");
    const sessions = (state.profiles ?? [])
      .filter((profile) => profile.id !== "connected-wallet")
      .map((profile) => ({
        id: profile.id,
        name: profile.name,
        kind: profile.kind,
        accountId: profile.accountId,
        status: profile.status,
        autonomyMode: profile.autonomyMode ?? null,
      }));
    // Agent treasury is always the server-managed env account (HEDERA_CLIENT_ID).
    const agentAccountId = config.agentPayerId ?? null;
    let agentTreasury: { accountId: string; hbarFormatted: number; funded: boolean; signerReady: boolean } | null = null;
    if (agentAccountId) {
      try {
        const portfolio = await readPortfolio(agentAccountId, { mirrorBaseUrl: config.mirrorNodeBaseUrl });
        agentTreasury = {
          accountId: agentAccountId,
          hbarFormatted: portfolio.hbarFormatted,
          funded: portfolio.hbarFormatted > 0,
          signerReady: Boolean(config.agentPayerId && config.agentPayerKey),
        };
      } catch {
        agentTreasury = {
          accountId: agentAccountId,
          hbarFormatted: 0,
          funded: false,
          signerReady: Boolean(config.agentPayerId && config.agentPayerKey),
        };
      }
    }
    return c.json(jsonSafe({
      connectedAccountId: account?.accountId ?? null,
      userProfileId: userWallet?.id ?? null,
      agentProfileId: agentProfile?.id ?? null,
      activeProfileId: state.activeProfileId ?? resolveActiveProfile(state)?.id ?? null,
      sessions,
      agentTreasury,
      autonomyMode: userWallet?.autonomyMode ?? agentProfile?.autonomyMode ?? null,
    }));
  });

  app.post("/api/v1/onboarding/complete", async (c) => {
    try {
      const body = await c.req.json<{ autonomyMode: 1 | 2 | 3 | 4; objective?: string }>();
      if (![1, 2, 3, 4].includes(body.autonomyMode)) {
        return c.json({ error: "autonomyMode must be 1, 2, 3, or 4" }, 400);
      }
      const now = new Date().toISOString();
      const state = store.getState();
      const userWallet = findUserWalletForAccount(state, state.account?.accountId);
      if (!userWallet && body.autonomyMode !== 4) {
        return c.json({ error: "Connect a wallet before choosing this autonomy mode" }, 400);
      }

      if (body.autonomyMode === 4) {
        if (!config.agentPayerId || !config.agentPayerKey) {
          return c.json({ error: "Autonomous mode needs a configured agent signer account" }, 409);
        }
        // Mode 4 always uses the server-managed treasury from HEDERA_CLIENT_ID / KEY.
        let agent = (store.getState().profiles ?? []).find((profile) => profile.id === "agent-managed")
          ?? (store.getState().profiles ?? []).find((profile) => profile.kind === "agent_managed");
        agent = store.upsertProfile({
          id: agent?.id ?? "agent-managed",
          name: agent?.name ?? "Autonomous agent",
          kind: "agent_managed",
          accountId: config.agentPayerId,
          network: config.hederaNetwork,
          status: "paused",
          autonomyMode: 4,
          cadenceMinutes: agent?.cadenceMinutes ?? store.getState().schedule.intervalMinutes,
          createdAt: agent?.createdAt ?? now,
          updatedAt: now,
        });
        if (!store.getLatestMandate(agent.id)) {
          store.saveMandate({
            id: `${agent.id}-mandate-v1`,
            profileId: agent.id,
            version: 1,
            objective: "Keep HBAR, USDC, and SAUCE within their configured allocation bands.",
            allocations: [
              { symbol: "HBAR", minPct: 25, targetPct: 34, maxPct: 45 },
              { symbol: "USDC", minPct: 25, targetPct: 33, maxPct: 45 },
              { symbol: "SAUCE", minPct: 10, targetPct: 33, maxPct: 40 },
            ],
            risk: { maxTradePct: 5, maxTradesPerDay: 6, maxSlippageBps: Number(config.tradeSlippageBps ?? "100") },
            createdAt: now,
          });
        }
        try {
          const portfolio = await readPortfolio(config.agentPayerId, { mirrorBaseUrl: config.mirrorNodeBaseUrl });
          if (portfolio.hbarFormatted <= 0) {
            return c.json({
              error: "Fund the agent treasury before enabling autonomous execution",
              agentAccountId: config.agentPayerId,
              funded: false,
            }, 409);
          }
        } catch {
          return c.json({
            error: "Unable to verify agent treasury funding on Mirror Node",
            agentAccountId: config.agentPayerId,
          }, 503);
        }
        const updated = store.upsertProfile({
          ...agent,
          accountId: config.agentPayerId,
          status: "active",
          autonomyMode: 4,
          updatedAt: now,
        });
        // Fresh autonomous onboarding must not inherit a previous kill-switch lock.
        if (store.isHalted()) store.setSystemHalt(false);
        store.updateSchedule({ enabled: true, autonomousTrading: true });
        agentScheduler.start();
        if (body.objective) {
          const previous = store.getLatestMandate(updated.id);
          if (previous) store.saveMandate({ ...previous, id: crypto.randomUUID(), version: previous.version + 1, objective: body.objective, createdAt: now });
        }
        // Pause every user-wallet session so the dashboard prefers the agent treasury.
        for (const wallet of store.getState().profiles ?? []) {
          if (wallet.kind === "user_wallet" && wallet.status === "active") {
            store.upsertProfile({ ...wallet, status: "paused", updatedAt: now });
          }
        }
        store.setActiveProfileId(updated.id);
        sseBroadcaster.broadcast("profile.schedule.updated", { autonomyMode: 4 }, { profileId: updated.id });
        return c.json(jsonSafe({ profile: updated, autonomyMode: 4, custody: "agent_managed" }));
      }

      // Pause siblings so only this wallet session is live.
      for (const other of store.getState().profiles ?? []) {
        if (other.id === userWallet!.id) continue;
        if (other.status === "active") {
          store.upsertProfile({ ...other, status: "paused", updatedAt: now });
        }
      }
      const profile = store.upsertProfile({
        ...userWallet!,
        status: "active",
        autonomyMode: body.autonomyMode,
        updatedAt: now,
      });
      if (profile.id !== "connected-wallet") {
        store.upsertProfile({
          ...profile,
          id: "connected-wallet",
          name: "Connected wallet",
        });
      }
      store.setActiveProfileId(profile.id);
      if (store.isHalted()) store.setSystemHalt(false);
      store.updateSchedule({
        enabled: body.autonomyMode >= 2,
        autonomousTrading: false,
      });
      if (body.autonomyMode >= 2) agentScheduler.start();
      else agentScheduler.stop();
      if (body.objective) {
        const previous = store.getLatestMandate(profile.id);
        if (previous) store.saveMandate({ ...previous, id: crypto.randomUUID(), version: previous.version + 1, objective: body.objective, createdAt: now });
      }
      sseBroadcaster.broadcast("profile.schedule.updated", { autonomyMode: body.autonomyMode }, { profileId: profile.id });
      return c.json(jsonSafe({
        profile,
        autonomyMode: body.autonomyMode,
        custody: "user_wallet",
        approvalRequired: body.autonomyMode === 3,
      }));
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
  });

  // --- Multi-Asset Agent Run & Stream Endpoints ---

  app.post("/api/agent/run", async (c) => {
    let input: AgentRunInput = {};
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        input = await c.req.json<AgentRunInput>();
      } catch {
        return c.json({ error: "Request body must be valid JSON" }, 400);
      }
    }
    const result = await agent.run(input);
    return c.json(result, 200);
  });

  app.post("/api/agent/manage", async (c) => {
    try {
      const result = await agentScheduler.triggerManualRun();
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to run agent" }, 500);
    }
  });

  app.get("/api/agent/history", (c) => c.json({
    runs: store.getState().runs,
    spending: store.getState().spending,
  }));

  app.get("/api/agent/stream", (c) => {
    return streamSSE(c, async (stream) => {
      const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const remove = sseBroadcaster.addClient(clientId, (data) => {
        void stream.write(data);
      });

      // Send initial state sync
      await stream.writeSSE({
        event: "sync",
        data: JSON.stringify({
          account: store.getState().account,
          schedule: store.getState().schedule,
          pendingTrades: store.getState().pendingTrades.filter((t) => t.status === "pending"),
          latestRun: store.getState().runs[0],
        }),
      });

      stream.onAbort(() => {
        remove();
      });

      // Keepalive loop
      while (true) {
        await stream.sleep(15_000);
        await stream.writeSSE({ event: "ping", data: JSON.stringify({ time: new Date().toISOString() }) });
      }
    });
  });

  // --- Schedule Endpoints ---

  app.get("/api/schedule", (c) => c.json(store.getState().schedule));

  app.post("/api/schedule", async (c) => {
    try {
      const body = await c.req.json<Partial<ScheduleConfig>>();
      const updated = store.updateSchedule(body);
      if (updated.enabled) {
        agentScheduler.start();
      } else {
        agentScheduler.stop();
      }
      return c.json(updated);
    } catch {
      return c.json({ error: "Invalid schedule config JSON" }, 400);
    }
  });

  app.post("/api/schedule/start", (c) => {
    agentScheduler.start();
    return c.json(store.getState().schedule);
  });

  app.post("/api/schedule/stop", (c) => {
    agentScheduler.stop();
    return c.json(store.getState().schedule);
  });

  // --- Pending Trades & Approval Queue ---

  app.get("/api/trades/pending", (c) => c.json(
    store.getState().pendingTrades.filter((t) => t.status === "pending"),
  ));

  app.post("/api/trades/:id/approve", async (c) => {
    try {
      const result = await executePendingTrade(c.req.param("id"));
      return c.json(jsonSafe(result.body), result.status);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Approval execution failed" }, 502);
    }
  });

  app.post("/api/trades/:id/reject", async (c) => {
    const tradeId = c.req.param("id");
    let reason = "User rejected trade";
    try {
      const body = await c.req.json<{ reason?: string }>();
      if (body?.reason) reason = body.reason;
    } catch {
      // Body optional
    }

    const updated = store.updatePendingTrade(tradeId, {
      status: "rejected",
      rejectionReason: reason,
    });

    if (!updated) return c.json({ error: "Pending trade not found" }, 404);
    const run = store.getState().runs.find((item) => item.id === updated.runId);
    if (run && !store.getState().pendingTrades.some((item) => item.runId === updated.runId && item.status === "pending")) {
      store.updateRun(run.id, { status: "completed", completedAt: run.completedAt ?? new Date().toISOString() }, store.getState().profiles?.find((profile) => profile.accountId === updated.accountId)?.id);
    }
    sseBroadcaster.broadcast("trade.rejected", { tradeId, reason });
    return c.json({ status: "rejected", trade: updated });
  });

  app.get("/api/trades/history", (c) => {
    const allExecutions = store.getState().runs.flatMap((r) => r.tradeExecutions);
    const approvedPendingExecutions = store.getState().pendingTrades
      .filter((t) => t.status === "approved" && t.executionResult)
      .map((t) => t.executionResult!);
    return c.json({
      executions: [...allExecutions, ...approvedPendingExecutions],
      pending: store.getState().pendingTrades.filter((t) => t.status === "pending"),
    });
  });

  // --- Catalog & Standard x402 Data Endpoints ---

  app.get("/catalog", (c) => c.json({ providerId: provider.id, products: catalog }));

  app.use("/data/:product", async (c, next) => {
    const productId = c.req.param("product");
    const error = validateRequest(catalog, productId, c.req.query());
    if (error) return c.json({ error: error.message }, error.status);
    await next();
  });

  if (initializePayments) {
    const x402Server = new x402ResourceServer(buildFacilitator(config.facilitatorUrl)).register(
      "hedera:*",
      new ExactHederaScheme(),
    );
    app.use("*", paymentMiddleware(routes, x402Server));
  }

  app.get("/data/:product", async (c) => {
    const productId = c.req.param("product");
    const params = c.req.query();
    const result = await provider.fetch(productId, params);
    return c.json({
      product: productId,
      params,
      data: result.data,
      asOf: result.asOf,
      providerId: result.providerId,
    });
  });

  return app;
};
