import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../core/config.js";
import type { DataProvider } from "../core/provider.js";
import type { AgentEvent, AgentRecommendation } from "./types.js";
import type { AgentMultiRunRecord, PendingTrade } from "../store/types.js";
import type { SaucerSwapConfig, TradeProposal } from "../trading/types.js";
import { readPortfolio } from "../portfolio/reader.js";
import { proposeBandRebalance, proposeRequestedTrade, validateAllocationBands, valuePortfolio } from "../portfolio/allocation.js";
import { fetchDisplayUsdPrices } from "../providers/market/market-provider.js";
import type { AllocationBand } from "../portfolio/types.js";
import { TradePolicy } from "../trading/policy.js";
import { AgentRunner } from "./runner.js";
import { store } from "../store/index.js";
import { sseBroadcaster } from "../server/stream.js";
import {
  DEFAULT_SAUCERSWAP_TESTNET, buildExactInputTransaction, createMirrorExactInputQuoter,
  quoteSaucerExactInput, resolveAccountEvmAddress,
} from "../trading/saucerswap.js";
import { executeSaucerSwap } from "../trading/executor.js";
import { insightFromPaidData, type MarketInsight } from "./insights.js";
import { MistralAdvisor } from "./mistral.js";
import { classifyObjective, focusSymbolFromObjective, formatTradeAmount, parseSwapPairFromObjective } from "./objective.js";

const ASSETS = ["HBAR", "USDC", "SAUCE"] as const;
const MIN_TRADE_USD = 0.5;
const DEFAULT_BANDS: AllocationBand[] = [
  { symbol: "HBAR", minPct: 25, targetPct: 34, maxPct: 45 },
  { symbol: "USDC", minPct: 25, targetPct: 33, maxPct: 45 },
  { symbol: "SAUCE", minPct: 10, targetPct: 33, maxPct: 40 },
];

function bandsForProfile(profileId?: string): AllocationBand[] {
  const mandate = profileId ? store.getLatestMandate(profileId) : null;
  const fromMandate = mandate?.allocations
    ?.filter((band): band is AllocationBand => ASSETS.includes(band.symbol as typeof ASSETS[number]))
    .map((band) => ({
      symbol: band.symbol,
      ...(band.tokenId ? { tokenId: band.tokenId } : {}),
      minPct: band.minPct,
      targetPct: band.targetPct,
      maxPct: band.maxPct,
    }));
  if (fromMandate && fromMandate.length === ASSETS.length) {
    try {
      validateAllocationBands(fromMandate);
      return fromMandate;
    } catch {
      return DEFAULT_BANDS;
    }
  }
  return DEFAULT_BANDS;
}

function paidSignal(data: unknown): { price?: number; provenance: "live" | "fallback" } | undefined {
  if (!data || typeof data !== "object") return undefined;
  const outer = data as Record<string, unknown>;
  const inner = outer.data && typeof outer.data === "object" ? outer.data as Record<string, unknown> : outer;
  const bid = typeof inner.bid === "number" ? inner.bid : undefined;
  const ask = typeof inner.ask === "number" ? inner.ask : undefined;
  const mid = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined;
  const value = inner.price ?? inner.close ?? inner.usd ?? mid ?? bid ?? ask;
  const fallback = inner.isLive === false || String(outer.providerId ?? "").includes("fallback") || String(inner.source ?? "").includes("fallback");
  return { price: typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined, provenance: fallback ? "fallback" : "live" };
}

function saucerConfig(config: ServerConfig): SaucerSwapConfig {
  return {
    routerId: config.saucerRouterId ?? DEFAULT_SAUCERSWAP_TESTNET.routerId,
    quoterId: config.saucerQuoterId ?? DEFAULT_SAUCERSWAP_TESTNET.quoterId,
    whbarTokenId: config.saucerWhbarTokenId ?? DEFAULT_SAUCERSWAP_TESTNET.whbarTokenId,
    tokenIds: {
      HBAR: "0.0.0",
      USDC: config.saucerUsdcTokenId ?? DEFAULT_SAUCERSWAP_TESTNET.tokenIds.USDC,
      SAUCE: config.saucerSauceTokenId ?? DEFAULT_SAUCERSWAP_TESTNET.tokenIds.SAUCE,
    },
    feeTier: Number(config.saucerFeeTier ?? DEFAULT_SAUCERSWAP_TESTNET.feeTier),
  };
}

/**
 * Multi-asset orchestration buys real x402 intelligence through AgentRunner.  It
 * deliberately produces proposals only: execution is delegated to the SaucerSwap
 * signer boundary and never falls back to a plain transfer or demo transaction.
 */
export class MultiAssetAgentRunner {
  private readonly tradePolicy: TradePolicy;
  private readonly intelligence: AgentRunner;
  private readonly advisor: MistralAdvisor;
  private readonly signalCache = new Map<string, { price: number; at: number; provenance: "live" | "fallback"; data?: unknown; productId?: string; transactionId?: string; hashscanUrl?: string }>();

  constructor(private readonly config: ServerConfig, _provider?: DataProvider) {
    this.intelligence = new AgentRunner(config);
    this.advisor = new MistralAdvisor({
      apiKey: config.mistralApiKey,
      model: config.mistralModel ?? "mistral-small-latest",
    });
    this.tradePolicy = new TradePolicy({
      maxTradeAmountTinybar: BigInt(config.tradeMaxAmountTinybar ?? "1000000000"),
      maxSlippageBps: Number(config.tradeSlippageBps ?? "500"),
      maxTradePct: 5, maxPortfolioMovePct: 5, maxPriceImpactBps: 200, maxTradesPerDay: 6, maxDailyTradePct: 15,
      // Testnet HBAR can trade below $0.10; a 10 HBAR hard cap must still be able
      // to form a small approval-gated validation order.
      minTradeUsd: MIN_TRADE_USD,
      allowedSymbols: ["HBAR", "USDC", "SAUCE"],
    });
  }

  async runMultiAsset(inputAccount?: string, input: { objective?: string; idempotencyKey?: string; profileId?: string } = {}): Promise<AgentMultiRunRecord> {
    const runId = randomUUID();
    const state = store.getState();
    // Prefer the active agent treasury / requested profile — never a stale paused wallet.
    const activeAgent = state.profiles?.find((profile) => profile.kind === "agent_managed" && profile.status === "active");
    const activeWallet = state.profiles?.find((profile) => profile.kind === "user_wallet" && profile.status === "active");
    const accountId = inputAccount
      ?? (input.profileId ? state.profiles?.find((profile) => profile.id === input.profileId)?.accountId : undefined)
      ?? activeAgent?.accountId
      ?? activeWallet?.accountId
      ?? state.account?.accountId
      ?? state.profiles?.find((profile) => profile.kind === "agent_managed")?.accountId;
    if (!accountId) throw new Error("A real Hedera account must be connected before running the agent");
    const profileId = input.profileId
      ?? state.profiles?.find((profile) => profile.accountId === accountId && profile.status === "active")?.id
      ?? state.profiles?.find((profile) => profile.kind === "user_wallet" && profile.accountId === accountId)?.id
      ?? state.profiles?.find((profile) => profile.id === "connected-wallet" && profile.accountId === accountId)?.id
      ?? state.profiles?.find((profile) => profile.accountId === accountId)?.id;
    const events: AgentEvent[] = [];
    const event = (kind: AgentEvent["kind"], title: string, detail: string, metadata?: Record<string, unknown>) => {
      const value: AgentEvent = { seq: events.length + 1, kind, at: new Date().toISOString(), title, detail, metadata };
      events.push(value); sseBroadcaster.broadcast("agent.event", { runId, event: value }, { profileId, runId });
    };
    const think = (detail: string, title = "Thinking") => {
      event("agent.thinking", title, detail, { presentInUi: true });
    };
    const conclude = (record: AgentMultiRunRecord, headline: string, bullets: string[]) => {
      // Do not re-emit the headline as a thought — that duplicated the Conclusion card.
      event("run.completed", "Conclusion", headline.replace(/^Conclusion:\s*/i, "Conclusion: "), {
        presentInUi: true,
        bullets,
        recommendation: record.recommendation,
        status: record.status,
        spentDataHbar: record.spentDataHbar,
        purchases: record.dataPurchases.map((purchase) => purchase.symbol),
      });
    };
    const objective = input.objective?.trim().slice(0, 600) || "Autonomous multi-asset portfolio monitoring and rebalancing";
    const userProvidedObjective = Boolean(input.objective?.trim());
    const intent = classifyObjective(objective, userProvidedObjective);
    const focusSymbol = focusSymbolFromObjective(objective);
    const record: AgentMultiRunRecord = {
      id: runId,
      accountId,
      ...(profileId ? { profileId } : {}),
      startedAt: new Date().toISOString(),
      status: "running",
      objective,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      dataPurchases: [],
      spentDataHbar: 0,
      tradeProposals: [],
      tradeExecutions: [],
      pendingTradeIds: [],
      events,
    };
    store.addRun(record, profileId);
    try {
      if (store.isHalted()) throw new Error("Global kill switch is active");
      if (userProvidedObjective) {
        // User text already appears as the chat bubble — don't echo it again on Check-in started.
        event("user.message", "You", objective, { role: "user", presentInUi: true });
        event("run.triggered", "Check-in started", "Working your request.", { objective, presentInUi: true });
      } else {
        event("run.triggered", "Check-in started", objective, { objective, presentInUi: true });
      }
      const rawPortfolio = await readPortfolio(accountId);
      record.portfolioBefore = rawPortfolio; store.updateRun(runId, { portfolioBefore: rawPortfolio }, profileId);
      const mode = state.profiles?.find((profile) => profile.id === profileId)?.autonomyMode ?? 3;
      const explicitPair = parseSwapPairFromObjective(objective);
      const allowTradeEarly = intent === "act" && mode >= 3;
      const directedPair = allowTradeEarly ? explicitPair : undefined;

      if (mode === 1) {
        const observeThoughts = await this.advisor.narrate({
          stage: "observe_only",
          objective,
          facts: { mode, accountId, holdings: rawPortfolio.allocations.map((a) => ({ symbol: a.symbol, balance: a.balanceFormatted })) },
          fallback: ["Mode 1 is observe-only — recording the live portfolio, then stopping without paid reads or trades."],
        });
        for (const line of observeThoughts) think(line);
        record.recommendation = { summary: "Observe-only mode recorded the live portfolio without purchasing intelligence or proposing a trade.", action: "watch", confidence: 1, rationale: ["Autonomy mode 1"], source: "deterministic" };
        record.status = "completed"; record.completedAt = new Date().toISOString();
        event("analysis.completed", "Observe-only check-in complete", record.recommendation.summary);
        conclude(record, "Conclusion: observed the live portfolio only — no paid CoinGecko reads and no trade.", [
          `Account ${accountId} balances were read live from Hedera.`,
          "Observe-only mode forbids buying market data or placing trades.",
        ]);
        store.updateRun(runId, record, profileId);
        sseBroadcaster.broadcast("agent.completed", { runId, record }, { profileId, runId });
        return record;
      }

      // Model chooses which sleeves to price and whether this run should prepare a trade.
      const plan = await this.advisor.planRun({
        objective,
        intent,
        mode,
        ...(focusSymbol ? { focusSymbol } : {}),
        ...(directedPair ? { directedPair } : {}),
        holdings: rawPortfolio.allocations.map((item) => ({
          symbol: item.symbol,
          balanceFormatted: item.balanceFormatted,
        })),
        allowTrade: allowTradeEarly,
      });
      for (const line of plan.thoughts) think(line);

      const prices: Record<string, number> = {};
      const insights: MarketInsight[] = [];
      const watched = state.schedule.watchedSymbols;
      let selected = plan.symbols.filter((symbol) => watched.length === 0 || watched.includes(symbol));
      if (plan.fromSymbol && !selected.includes(plan.fromSymbol)) selected = [...selected, plan.fromSymbol];
      if (plan.toSymbol && !selected.includes(plan.toSymbol)) selected = [...selected, plan.toSymbol];
      if (!selected.length) selected = directedPair
        ? [directedPair.fromSymbol as typeof ASSETS[number], directedPair.toSymbol as typeof ASSETS[number]]
        : [...ASSETS];
      // Open-ended trades need enough live legs for pickTrade; research/directed stays lean.
      if (allowTradeEarly && !directedPair && selected.length < 2) {
        selected = ASSETS.filter((symbol) => watched.length === 0 || watched.includes(symbol));
      }
      // Full-band rebalances still need every sleeve priced; directed / research plans may be leaner.
      const needsFullBook = !directedPair && intent !== "research" && !plan.wantTrade && plan.symbols.length >= ASSETS.length;
      if (needsFullBook && selected.length !== ASSETS.length) {
        selected = ASSETS.filter((symbol) => watched.length === 0 || watched.includes(symbol));
      }
      if (needsFullBook && selected.length !== ASSETS.length) {
        throw new Error("HBAR, USDC, and SAUCE must all have live intelligence before allocation decisions");
      }
      let spend = 0n;
      const cycleBudget = BigInt(Math.floor(state.schedule.dataBudgetHbar * 1e8));
      const dailyBudget = BigInt(Math.floor(state.schedule.dailyBudgetCapHbar * 1e8));
      const alreadySpentToday = BigInt(Math.floor(state.spending.todayDataHbar * 1e8));
      for (const symbol of selected) {
        const cached = this.signalCache.get(symbol);
        // Never reuse labeled fallback quotes — they invent prices (e.g. SAUCE at $279).
        if (cached && cached.provenance !== "fallback" && Date.now() - cached.at < 60_000) {
          prices[symbol] = cached.price;
          event("data.received", `${symbol} market data reused`, `Still fresh from a recent paid read — about $${cached.price} each.`, { provenance: "cached", price: cached.price, symbol });
          if (cached.data) {
            record.dataPurchases.push({
              symbol,
              productId: cached.productId ?? "quote",
              amountHbar: 0,
              transactionId: `cache:${runId}:${symbol}`,
              hashscanUrl: cached.hashscanUrl ?? "",
              data: cached.data,
            });
            insights.push(insightFromPaidData(symbol, cached.data));
          }
          continue;
        }
        const remainingCycle = cycleBudget - spend;
        const remainingDaily = dailyBudget - alreadySpentToday - spend;
        const remaining = remainingCycle < remainingDaily ? remainingCycle : remainingDaily;
        if (remaining <= 0n) throw new Error("x402 data budget exhausted before all required asset signals were acquired");
        event("payment.required", `Paying for ${symbol} market data`, "Sending a tiny on-chain payment to unlock a fresh CoinGecko price for this asset.");
        // Brief pause between paid reads so CoinGecko rate limits are less likely mid-cycle.
        if (insights.length > 0) await new Promise((resolve) => setTimeout(resolve, 400));
        let result = await this.intelligence.run({
          symbol,
          objective: record.objective,
          portfolio: [],
          budgetAtomic: remaining.toString(),
          preferredProductId: "quote",
        });
        if (result.status !== "completed" || !result.purchase) throw new Error(`Unable to obtain verified paid intelligence for ${symbol}: ${result.error ?? "unknown error"}`);
        let signal = paidSignal(result.purchase.data);
        // If the quote payload was unusable (e.g. rate-limit fallback without price), retry spot.
        if (!signal?.price) {
          const retryBudget = remaining - BigInt(result.purchase.amountAtomic);
          if (retryBudget <= 0n) throw new Error(`Paid intelligence for ${symbol} lacked a usable price`);
          spend += BigInt(result.purchase.amountAtomic);
          store.recordSpend(Number(BigInt(result.purchase.amountAtomic)) / 1e8, 0, profileId);
          record.dataPurchases.push({ symbol, productId: result.purchase.productId, amountHbar: Number(BigInt(result.purchase.amountAtomic)) / 1e8, transactionId: result.purchase.transactionId, hashscanUrl: result.purchase.hashscanUrl, data: result.purchase.data });
          result = await this.intelligence.run({
            symbol,
            objective: record.objective,
            portfolio: [],
            budgetAtomic: retryBudget.toString(),
            preferredProductId: "spot-price",
          });
          if (result.status !== "completed" || !result.purchase) throw new Error(`Unable to obtain verified paid intelligence for ${symbol}: ${result.error ?? "unknown error"}`);
          signal = paidSignal(result.purchase.data);
        }
        if (!signal?.price) throw new Error(`Paid intelligence for ${symbol} lacked a usable price`);
        spend += BigInt(result.purchase.amountAtomic);
        const amountHbar = Number(BigInt(result.purchase.amountAtomic)) / 1e8;
        record.dataPurchases.push({ symbol, productId: result.purchase.productId, amountHbar, transactionId: result.purchase.transactionId, hashscanUrl: result.purchase.hashscanUrl, data: result.purchase.data });
        store.recordSpend(amountHbar, 0, profileId);
        if (signal.provenance === "fallback") {
          // Still record the paid receipt, but do not mark the book or authorize trades on fake prices.
          event(
            "payment.settled",
            `${symbol} market data paid — live feed unavailable`,
            `Payment settled, but CoinGecko returned a labeled fallback for ${symbol}. I will not size trades on that quote.`,
            { transactionId: result.purchase.transactionId, hashscanUrl: result.purchase.hashscanUrl, provenance: signal.provenance, price: signal.price, symbol },
          );
          continue;
        }
        prices[symbol] = signal.price;
        this.signalCache.set(symbol, {
          price: signal.price,
          at: Date.now(),
          provenance: signal.provenance,
          data: result.purchase.data,
          productId: result.purchase.productId,
          transactionId: result.purchase.transactionId,
          hashscanUrl: result.purchase.hashscanUrl,
        });
        event("payment.settled", `${symbol} market data unlocked`, `Paid and confirmed — ${symbol} is about $${signal.price}.`, { transactionId: result.purchase.transactionId, hashscanUrl: result.purchase.hashscanUrl, provenance: signal.provenance, price: signal.price, symbol });
        insights.push(insightFromPaidData(symbol, result.purchase.data));
      }
      const tapeThoughts = await this.advisor.narrate({
        stage: "paid_tape",
        objective,
        facts: {
          prices,
          insights: insights.map((item) => ({
            symbol: item.symbol,
            price: item.price,
            change24hPercent: item.change24hPercent,
            sentences: item.sentences.slice(0, 2),
          })),
          planReason: plan.reason,
        },
        fallback: insights.flatMap((item) => item.sentences.slice(0, 1)).slice(0, 3),
      });
      for (const line of tapeThoughts) think(line);
      if (Object.keys(prices).length < selected.length) {
        throw new Error(`Need live CoinGecko prices for ${selected.join(", ")} before trading — got ${Object.keys(prices).join(", ") || "none"}. Retry in a minute if CoinGecko rate-limited.`);
      }
      // Fill any unpriced managed sleeve from display quotes so the sidebar mix stays coherent.
      if (Object.keys(prices).length < ASSETS.length) {
        const display = await fetchDisplayUsdPrices(ASSETS.filter((symbol) => prices[symbol] === undefined));
        for (const [symbol, price] of Object.entries(display.prices)) {
          if (prices[symbol] === undefined) prices[symbol] = price;
        }
      }
      record.spentDataHbar = Number(spend) / 1e8;
      const managedAllocations = ASSETS.map((symbol) => rawPortfolio.allocations.find((allocation) => allocation.symbol.toUpperCase() === symbol) ?? {
        symbol,
        tokenId: symbol === "HBAR" ? undefined : saucerConfig(this.config).tokenIds[symbol],
        balanceFormatted: 0,
        usdValue: 0,
        allocationPct: 0,
      });
      const portfolio = valuePortfolio({ ...rawPortfolio, allocations: managedAllocations }, prices);
      record.portfolioBefore = portfolio; store.updateRun(runId, { portfolioBefore: portfolio, dataPurchases: record.dataPurchases, spentDataHbar: record.spentDataHbar }, profileId);
      const bands = bandsForProfile(profileId);
      // Model plan can decline a trade even when intent is act (e.g. thin book) —
      // but directed user swaps and wantTrade=true stay on the executable path.
      const allowTrade = intent === "act" && mode >= 3 && (Boolean(directedPair) || plan.wantTrade);
      let preferredPair: { fromSymbol: string; toSymbol: string; reason: string; force?: boolean } | undefined;
      if (directedPair) {
        preferredPair = {
          fromSymbol: directedPair.fromSymbol,
          toSymbol: directedPair.toSymbol,
          reason: plan.reason || `Swap ${directedPair.fromSymbol} into ${directedPair.toSymbol} as requested.`,
          force: true,
        };
      } else if (allowTrade && plan.fromSymbol && plan.toSymbol) {
        preferredPair = {
          fromSymbol: plan.fromSymbol,
          toSymbol: plan.toSymbol,
          reason: plan.reason,
          force: true,
        };
      } else if (allowTrade) {
        const picked = await this.advisor.pickTrade({
          objective,
          ...(focusSymbol ? { focusSymbol } : {}),
          insights: insights.map((insight) => ({
            symbol: insight.symbol,
            ...(insight.price !== undefined ? { price: insight.price } : {}),
            ...(insight.change24hPercent !== undefined ? { change24hPercent: insight.change24hPercent } : {}),
            ...(insight.volume24hUsd !== undefined ? { volume24hUsd: insight.volume24hUsd } : {}),
          })),
          allocations: portfolio.allocations.map((item) => ({
            symbol: item.symbol,
            allocationPct: item.allocationPct,
            usdValue: item.usdValue,
            balanceFormatted: item.balanceFormatted,
          })),
        });
        if (picked) preferredPair = { ...picked, force: true };
      }
      const candidate = allowTrade
        ? proposeRequestedTrade(portfolio.allocations, bands, preferredPair)
        : proposeBandRebalance(portfolio.allocations, bands);
      const brief = await this.advisor.briefObjective({
        objective,
        intent,
        mode,
        ...(focusSymbol ? { focusSymbol } : {}),
        insights: insights.map((insight) => ({
          symbol: insight.symbol,
          ...(insight.price !== undefined ? { price: insight.price } : {}),
          ...(insight.change24hPercent !== undefined ? { change24hPercent: insight.change24hPercent } : {}),
          ...(insight.volume24hUsd !== undefined ? { volume24hUsd: insight.volume24hUsd } : {}),
          sentences: insight.sentences,
        })),
        allocations: portfolio.allocations.map((item) => ({
          symbol: item.symbol,
          allocationPct: item.allocationPct,
          usdValue: item.usdValue,
        })),
        bands,
        candidate: {
          action: candidate.action,
          ...(candidate.fromSymbol ? { fromSymbol: candidate.fromSymbol } : {}),
          ...(candidate.toSymbol ? { toSymbol: candidate.toSymbol } : {}),
          reason: candidate.reason,
          ...(candidate.amountUsd !== undefined ? { amountUsd: candidate.amountUsd } : {}),
        },
      });
      for (const line of brief.thoughts) think(line);
      const recommendation: AgentRecommendation = {
        summary: brief.summary,
        action: allowTrade && candidate.action === "swap" ? "rebalance" : "watch",
        confidence: 0.85,
        rationale: brief.bullets.slice(0, 4),
        source: "mistral",
      };
      record.recommendation = recommendation;
      event(
        "analysis.completed",
        intent === "research"
          ? "Researching the market tape"
          : intent === "act" && candidate.action === "swap"
            ? "Preparing your swap"
            : "Reading the paid tape",
        intent === "act" && candidate.action === "swap"
          ? candidate.reason
          : brief.summary,
        { recommendation, insights, candidate, intent, presentInUi: true },
      );
      if (mode === 2 || !allowTrade) {
        record.status = "completed"; record.completedAt = new Date().toISOString();
        conclude(record, `Conclusion: ${brief.summary}`, brief.bullets.length ? brief.bullets : [
          `Paid/reused CoinGecko quotes for ${Object.keys(prices).join(", ")}.`,
          `Portfolio marked at about $${(portfolio.totalUsdValue ?? 0).toFixed(2)}.`,
          intent === "research" ? "Research-only — no order was proposed or submitted." : "Advise path — no order was proposed or submitted.",
        ]);
        store.updateRun(runId, record, profileId);
        sseBroadcaster.broadcast("agent.completed", { runId, record }, { profileId, runId });
        return record;
      }
      if (candidate.action === "swap" && candidate.fromSymbol && candidate.toSymbol) {
        const source = portfolio.allocations.find((allocation) => allocation.symbol === candidate.fromSymbol);
        const configuredMaxPct = 5;
        const maxAtomic = Number(BigInt(this.config.tradeMaxAmountTinybar ?? "1000000000")) / 1e8;
        const hbarAtomicCapPct = candidate.fromSymbol === "HBAR" && source?.balanceFormatted
          ? maxAtomic / source.balanceFormatted * 100
          : configuredMaxPct;
        let executablePct = Math.min(candidate.percentage, configuredMaxPct, hbarAtomicCapPct);
        let amountFormatted = source ? source.balanceFormatted * executablePct / 100 : 0;
        let amountUsd = (source?.usdValue ?? 0) * executablePct / 100;
        // If band math undershoots the policy minimum, size up to minTradeUsd (still capped).
        if (source && amountUsd > 0 && amountUsd < MIN_TRADE_USD) {
          const price = prices[candidate.fromSymbol] ?? (source.usdValue / Math.max(source.balanceFormatted, 1e-12));
          const minAmount = MIN_TRADE_USD / Math.max(price, 1e-12);
          const maxAmount = Math.min(
            source.balanceFormatted * configuredMaxPct / 100,
            candidate.fromSymbol === "HBAR" ? maxAtomic : source.balanceFormatted,
            source.balanceFormatted,
          );
          amountFormatted = Math.min(Math.max(amountFormatted, minAmount), maxAmount);
          executablePct = source.balanceFormatted > 0 ? amountFormatted / source.balanceFormatted * 100 : executablePct;
          amountUsd = amountFormatted * price;
        }
        const fromInsight = insights.find((item) => item.symbol === candidate.fromSymbol);
        const toInsight = insights.find((item) => item.symbol === candidate.toSymbol);
        const proposal: TradeProposal = {
          action: "swap",
          fromSymbol: candidate.fromSymbol,
          toSymbol: candidate.toSymbol,
          percentage: executablePct,
          amountFormatted,
          reasoning: [
            candidate.reason,
            fromInsight?.change24hPercent !== undefined ? `${candidate.fromSymbol} 24h ${fromInsight.change24hPercent.toFixed(2)}% on CoinGecko.` : undefined,
            toInsight?.change24hPercent !== undefined ? `${candidate.toSymbol} 24h ${toInsight.change24hPercent.toFixed(2)}% on CoinGecko.` : undefined,
            "Executable tranche is capped by portfolio policy.",
          ].filter(Boolean).join(" "),
          confidence: 1,
          source: preferredPair || plan.source === "mistral" ? "mistral" : "deterministic",
        };
        record.tradeProposals = [proposal];
        const sizeThoughts = await this.advisor.narrate({
          stage: "size_swap",
          objective,
          facts: {
            fromSymbol: candidate.fromSymbol,
            toSymbol: candidate.toSymbol,
            amountFormatted,
            amountUsd,
            reason: proposal.reasoning,
          },
          fallback: [`Preparing about ${amountFormatted.toFixed(4)} ${candidate.fromSymbol} (~$${amountUsd.toFixed(2)}) into ${candidate.toSymbol}.`],
        });
        for (const line of sizeThoughts) think(line);
        const fromToken = candidate.fromSymbol === "HBAR" ? undefined : rawPortfolio.tokens.find((token) => token.symbol.toUpperCase() === candidate.fromSymbol);
        const toToken = candidate.toSymbol === "HBAR" ? undefined : rawPortfolio.tokens.find((token) => token.symbol.toUpperCase() === candidate.toSymbol);
        const fromDecimals = candidate.fromSymbol === "HBAR" ? 8 : fromToken?.decimals;
        const toDecimals = candidate.toSymbol === "HBAR" ? 8 : toToken?.decimals ?? 6;
        if (fromDecimals === undefined) throw new Error(`Cannot quote ${candidate.fromSymbol}: token decimals are unavailable`);
        const amountIn = BigInt(Math.floor(proposal.amountFormatted * 10 ** fromDecimals));
        const dexConfig = saucerConfig(this.config);
        const quote = await quoteSaucerExactInput({
          fromSymbol: candidate.fromSymbol, toSymbol: candidate.toSymbol, amountIn,
          amountInFormatted: proposal.amountFormatted, expectedAmountOutFormatted: 0,
          config: dexConfig,
          quoter: createMirrorExactInputQuoter({ mirrorBaseUrl: this.config.mirrorNodeBaseUrl, config: dexConfig }),
        });
        quote.expectedAmountOutFormatted = Number(quote.expectedAmountOut) / 10 ** toDecimals;
        quote.amountOutMinimum = quote.expectedAmountOut * BigInt(10_000 - Number(this.config.tradeSlippageBps ?? "100")) / 10_000n;
        const provenance = Array.from(this.signalCache.values()).some((signal) => signal.provenance === "fallback") ? "fallback" : "live";
        const policy = this.tradePolicy.validate(proposal, { availableBalance: source?.balanceFormatted ?? 0, portfolioUsd: portfolio.totalUsdValue ?? 0, amountUsd, provenance, halted: store.isHalted(), quote });
        event(
          policy.approved ? "trade.proposed" : "trade.skipped",
          policy.approved ? "Ready to rebalance" : "Rebalance held back",
          policy.approved
            ? `Planning to exchange about ${proposal.amountFormatted.toFixed(4)} ${proposal.fromSymbol} for ${candidate.toSymbol}.`
            : policy.reason,
          { proposal, amountUsd },
        );
        if (policy.approved) {
          const builtTransaction = buildExactInputTransaction({
            quote,
            recipientSolidityAddress: await resolveAccountEvmAddress(accountId, { mirrorBaseUrl: this.config.mirrorNodeBaseUrl }),
            slippageBps: Number(this.config.tradeSlippageBps ?? "100"), config: dexConfig, ttlSeconds: 600,
          });
          const canExecuteAutonomously = state.schedule.autonomousTrading && accountId === this.config.agentPayerId && Boolean(this.config.agentPayerKey);
          if (canExecuteAutonomously) {
            event("trade.approved", "Safety checks passed — sending the trade", "Market data, portfolio bands, and the live exchange quote all agree. Sending from the agent treasury.", { quote, presentInUi: true });
            event("trade.submitted", "Exchange order sent", "Waiting for the network to confirm the swap.", { quote });
            const result = await executeSaucerSwap({ payerId: accountId, payerKey: this.config.agentPayerKey!, quote, transaction: builtTransaction, mirrorBaseUrl: this.config.mirrorNodeBaseUrl });
            record.tradeExecutions.push(result);
            store.recordSpend(0, proposal.amountFormatted, profileId);
            event(
              "trade.verified",
              "Swap completed",
              `Exchanged ${proposal.amountFormatted.toFixed(4)} ${proposal.fromSymbol} for about ${Number(quote.expectedAmountOutFormatted).toFixed(4)} ${proposal.toSymbol}.`,
              { result, transactionId: result.transactionId },
            );
            const execThoughts = await this.advisor.narrate({
              stage: "swap_confirmed",
              objective,
              facts: {
                fromSymbol: proposal.fromSymbol,
                toSymbol: proposal.toSymbol,
                amountIn: proposal.amountFormatted,
                amountOut: Number(quote.expectedAmountOutFormatted),
              },
              fallback: [`Swap confirmed: ${proposal.amountFormatted.toFixed(4)} ${proposal.fromSymbol} → about ${Number(quote.expectedAmountOutFormatted).toFixed(4)} ${proposal.toSymbol}.`],
            });
            for (const line of execThoughts) think(line);
            try {
              const afterRaw = await readPortfolio(accountId);
              const afterManaged = ASSETS.map((symbol) => afterRaw.allocations.find((allocation) => allocation.symbol.toUpperCase() === symbol) ?? {
                symbol,
                tokenId: symbol === "HBAR" ? undefined : dexConfig.tokenIds[symbol],
                balanceFormatted: 0,
                usdValue: 0,
                allocationPct: 0,
              });
              const after = valuePortfolio({ ...afterRaw, allocations: afterManaged }, prices);
              record.portfolioAfter = after;
              store.updateRun(runId, { portfolioAfter: after, tradeExecutions: record.tradeExecutions }, profileId);
              const mix = after.allocations.map((item) => `${item.symbol} ${item.allocationPct.toFixed(1)}%`).join(" · ");
              event(
                "portfolio.updated",
                "Portfolio refreshed after the swap",
                `Balances and mix updated — ${mix} (about $${(after.totalUsdValue ?? 0).toFixed(2)} total).`,
                { portfolio: after, presentInUi: true },
              );
            } catch {
              // Next check-in refreshes balances if Mirror lags.
            }
          } else {
            const waitThoughts = await this.advisor.narrate({
              stage: "awaiting_approval",
              objective,
              facts: {
                fromSymbol: proposal.fromSymbol,
                toSymbol: proposal.toSymbol,
                amountFormatted: proposal.amountFormatted,
                expectedOut: Number(quote.expectedAmountOutFormatted),
              },
              fallback: ["Quote is ready — pausing for your approval before anything moves."],
            });
            for (const line of waitThoughts) think(line);
            const pending: PendingTrade = { id: randomUUID(), runId, accountId, proposal, quote, builtTransaction, createdAt: new Date().toISOString(), status: "pending" };
            store.addPendingTrade(pending, profileId); record.pendingTradeIds.push(pending.id); record.status = "waiting_approval";
          }
        } else {
          const skipThoughts = await this.advisor.narrate({
            stage: "policy_hold",
            objective,
            facts: { reason: policy.reason, candidate },
            fallback: [`Held the sale back: ${policy.reason}`],
          });
          for (const line of skipThoughts) think(line);
        }
      } else if (allowTrade) {
        const missThoughts = await this.advisor.narrate({
          stage: "no_safe_swap",
          objective,
          facts: { candidate, allocations: portfolio.allocations },
          fallback: ["I wanted a trade for you, but could not size a safe swap from the current book."],
        });
        for (const line of missThoughts) think(line);
      }
      if (record.status !== "waiting_approval") record.status = "completed";
      record.completedAt = new Date().toISOString();
      const snapshot = record.portfolioAfter ?? portfolio;
      const hbar = snapshot.allocations.find((allocation) => allocation.symbol === "HBAR");
      const traded = record.tradeExecutions[0];
      const pending = record.status === "waiting_approval" || record.pendingTradeIds.length > 0;
      const conclusion = traded
        ? `Conclusion: rebalanced — ${formatTradeAmount(traded.amountInFormatted)} ${traded.fromSymbol} → ${formatTradeAmount(traded.amountOutFormatted)} ${traded.toSymbol}.`
        : pending
          ? `Conclusion: prepared a rebalance and paused for your approval.`
          : record.tradeProposals[0]
            ? `Conclusion: evaluated a rebalance but did not execute — ${record.events.find((item) => item.kind === "trade.skipped")?.detail ?? recommendation.summary}`
            : `Conclusion: ${recommendation.summary}`;
      conclude(record, conclusion, recommendation.rationale.length ? recommendation.rationale : [
        `Fresh market prices used for ${Object.keys(prices).join(", ")} (${record.dataPurchases.filter((p) => !p.transactionId.startsWith("cache:")).length} paid data reads this cycle).`,
        `Portfolio about $${(snapshot.totalUsdValue ?? 0).toFixed(2)}${hbar ? ` · HBAR ${hbar.allocationPct.toFixed(1)}% of the mix` : ""}.`,
        traded
          ? `Swap confirmed on Hedera — you can open the receipt link for proof.`
          : pending
            ? "Waiting for your approval before any funds move."
            : "No trade cleared the safety checks this cycle.",
      ]);
      store.updateRun(runId, record, profileId); sseBroadcaster.broadcast("agent.completed", { runId, record }, { profileId, runId }); return record;
    } catch (error) {
      record.status = "failed"; record.error = error instanceof Error ? error.message : "Multi-asset agent run failed"; record.completedAt = new Date().toISOString();
      event("run.failed", "Run stopped safely", record.error);
      conclude(record, `Conclusion: stopped safely — ${record.error}`, [
        "No unverified trade was reported as success.",
        "You can retry once the underlying issue is resolved.",
      ]);
      store.updateRun(runId, record, profileId); sseBroadcaster.broadcast("agent.completed", { runId, record }, { profileId, runId }); return record;
    }
  }
}
