import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../core/config.js";
import type { DataProvider } from "../core/provider.js";
import type { AgentEvent, AgentRecommendation } from "./types.js";
import type { AgentMultiRunRecord, PendingTrade } from "../store/types.js";
import type { SaucerSwapConfig, TradeProposal } from "../trading/types.js";
import { readPortfolio } from "../portfolio/reader.js";
import { proposeBandRebalance, valuePortfolio } from "../portfolio/allocation.js";
import { TradePolicy } from "../trading/policy.js";
import { AgentRunner } from "./runner.js";
import { store } from "../store/index.js";
import { sseBroadcaster } from "../server/stream.js";
import {
  DEFAULT_SAUCERSWAP_TESTNET, buildExactInputTransaction, createMirrorExactInputQuoter,
  quoteSaucerExactInput, resolveAccountEvmAddress,
} from "../trading/saucerswap.js";
import { executeSaucerSwap } from "../trading/executor.js";
import { insightFromPaidData, portfolioInsightNarrative, type MarketInsight } from "./insights.js";

const ASSETS = ["HBAR", "USDC", "SAUCE"] as const;
const MIN_TRADE_USD = 0.5;
const DEFAULT_BANDS = [
  { symbol: "HBAR" as const, minPct: 25, targetPct: 34, maxPct: 45 },
  { symbol: "USDC" as const, minPct: 25, targetPct: 33, maxPct: 45 },
  { symbol: "SAUCE" as const, minPct: 10, targetPct: 33, maxPct: 40 },
];

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
  private readonly signalCache = new Map<string, { price: number; at: number; provenance: "live" | "fallback"; data?: unknown; productId?: string; transactionId?: string; hashscanUrl?: string }>();

  constructor(private readonly config: ServerConfig, _provider?: DataProvider) {
    this.intelligence = new AgentRunner(config);
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
      think(headline);
      event("run.completed", "Conclusion", headline, {
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
        event("user.message", "You", objective, { role: "user", presentInUi: true });
      }
      event("run.triggered", "Check-in started", objective, { objective, presentInUi: true });
      think(`Reading the request and planning a portfolio check-in for ${accountId}.`);
      event("portfolio.read", "Checking your live balances", `Looking up what this account currently holds on Hedera.`);
      const rawPortfolio = await readPortfolio(accountId);
      record.portfolioBefore = rawPortfolio; store.updateRun(runId, { portfolioBefore: rawPortfolio }, profileId);
      const mode = state.profiles?.find((profile) => profile.id === profileId)?.autonomyMode ?? 3;
      const hbarBal = rawPortfolio.allocations.find((a) => a.symbol.toUpperCase() === "HBAR")?.balanceFormatted;
      think(
        hbarBal === undefined
          ? "Live holdings are in. Next I need paid market prices for HBAR, USDC, and SAUCE before judging the mix."
          : `Holdings are in — ${hbarBal.toFixed(4)} HBAR on the book, plus any token balances. I still need fresh paid prices before any rebalance call.`,
      );
      if (mode === 1) {
        record.recommendation = { summary: "Observe-only mode recorded the live portfolio without purchasing intelligence or proposing a trade.", action: "watch", confidence: 1, rationale: ["Autonomy mode 1"], source: "deterministic" };
        record.status = "completed"; record.completedAt = new Date().toISOString();
        think("Mode 1 is observe-only, so I stop after recording the portfolio — no paid reads and no trade proposal.");
        event("analysis.completed", "Observe-only check-in complete", record.recommendation.summary);
        conclude(record, "Conclusion: observed the live portfolio only — no paid CoinGecko reads and no trade.", [
          `Account ${accountId} balances were read live from Hedera.`,
          "Observe-only mode forbids buying market data or placing trades.",
        ]);
        store.updateRun(runId, record, profileId);
        sseBroadcaster.broadcast("agent.completed", { runId, record }, { profileId, runId });
        return record;
      }
      const prices: Record<string, number> = {};
      const insights: MarketInsight[] = [];
      const selected = ASSETS.filter((symbol) => state.schedule.watchedSymbols.length === 0 || state.schedule.watchedSymbols.includes(symbol));
      if (selected.length !== ASSETS.length) throw new Error("HBAR, USDC, and SAUCE must all have live intelligence before allocation decisions");
      let spend = 0n;
      const cycleBudget = BigInt(Math.floor(state.schedule.dataBudgetHbar * 1e8));
      const dailyBudget = BigInt(Math.floor(state.schedule.dailyBudgetCapHbar * 1e8));
      const alreadySpentToday = BigInt(Math.floor(state.spending.todayDataHbar * 1e8));
      think("I'll buy CoinGecko quote intelligence for each sleeve (price, 24h change, volume) so the decision is backed by market tape, not just a bare spot.");
      for (const symbol of selected) {
        const cached = this.signalCache.get(symbol);
        if (cached && Date.now() - cached.at < 60_000) {
          prices[symbol] = cached.price;
          think(`${symbol} still has a paid CoinGecko signal inside its freshness window — reusing it instead of spending again.`);
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
            const insight = insightFromPaidData(symbol, cached.data);
            insights.push(insight);
            for (const sentence of insight.sentences) think(sentence);
          }
          continue;
        }
        const remainingCycle = cycleBudget - spend;
        const remainingDaily = dailyBudget - alreadySpentToday - spend;
        const remaining = remainingCycle < remainingDaily ? remainingCycle : remainingDaily;
        if (remaining <= 0n) throw new Error("x402 data budget exhausted before all required asset signals were acquired");
        think(`Requesting a paid CoinGecko quote for ${symbol} — I want the live price plus 24h change/volume before judging this sleeve.`);
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
        if (result.plan?.reason) think(result.plan.reason);
        for (const nested of result.events) {
          if (nested.kind === "payment.authorized" || nested.kind === "payment.settled") {
            think(nested.detail || nested.title);
          }
        }
        let signal = paidSignal(result.purchase.data);
        // If the quote payload was unusable (e.g. rate-limit fallback without price), retry spot.
        if (!signal?.price) {
          think(`${symbol} quote payload had no usable price — retrying with a paid CoinGecko spot read.`);
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
        prices[symbol] = signal.price; spend += BigInt(result.purchase.amountAtomic);
        this.signalCache.set(symbol, {
          price: signal.price,
          at: Date.now(),
          provenance: signal.provenance,
          data: result.purchase.data,
          productId: result.purchase.productId,
          transactionId: result.purchase.transactionId,
          hashscanUrl: result.purchase.hashscanUrl,
        });
        const amountHbar = Number(BigInt(result.purchase.amountAtomic)) / 1e8;
        record.dataPurchases.push({ symbol, productId: result.purchase.productId, amountHbar, transactionId: result.purchase.transactionId, hashscanUrl: result.purchase.hashscanUrl, data: result.purchase.data });
        store.recordSpend(amountHbar, 0, profileId);
        event("payment.settled", `${symbol} market data unlocked`, `Paid and confirmed — ${symbol} is about $${signal.price}.`, { transactionId: result.purchase.transactionId, hashscanUrl: result.purchase.hashscanUrl, provenance: signal.provenance, price: signal.price, symbol });
        const insight = insightFromPaidData(symbol, result.purchase.data);
        insights.push(insight);
        for (const sentence of insight.sentences) think(sentence);
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
      const mandate = profileId ? store.getLatestMandate(profileId) : undefined;
      const bands = (mandate?.allocations?.length ? mandate.allocations : DEFAULT_BANDS).map((band) => {
        const tokenId = "tokenId" in band && typeof band.tokenId === "string" ? band.tokenId : undefined;
        return {
          symbol: band.symbol,
          minPct: band.minPct,
          targetPct: band.targetPct,
          maxPct: band.maxPct,
          ...(tokenId ? { tokenId } : {}),
        };
      });
      think("All three paid CoinGecko reads are in. Comparing each sleeve against its allocation band next.");
      const candidate = proposeBandRebalance(portfolio.allocations, bands);
      const narrative = portfolioInsightNarrative({
        insights,
        allocations: portfolio.allocations,
        bands,
        candidate,
      });
      for (const line of narrative) think(line);
      const recommendation: AgentRecommendation = {
        summary: candidate.reason,
        action: candidate.action === "swap" ? "rebalance" : "watch",
        confidence: 1,
        rationale: narrative.slice(0, 4),
        source: "deterministic",
      };
      record.recommendation = recommendation;
      event("analysis.completed", "Comparing your mix to the target bands", recommendation.summary, { recommendation, insights });
      if (mode === 2) {
        think("Mode 2 stops at advice — recording the recommendation without proposing an executable order.");
        record.status = "completed"; record.completedAt = new Date().toISOString();
        conclude(record, `Conclusion: ${recommendation.summary}`, [
          `Paid/reused CoinGecko quotes for ${Object.keys(prices).join(", ")}.`,
          `Portfolio marked at about $${(portfolio.totalUsdValue ?? 0).toFixed(2)}.`,
          "Advise-only mode — no order was proposed or submitted.",
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
          think(`The raw band move was below the $${MIN_TRADE_USD} minimum, so I sized the order up to about $${amountUsd.toFixed(2)} while staying inside the 5% / atomic caps.`);
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
          source: "deterministic",
        };
        record.tradeProposals = [proposal];
        think(`I want to sell ${amountFormatted.toFixed(4)} ${candidate.fromSymbol} (~$${amountUsd.toFixed(2)}) into ${candidate.toSymbol}. ${proposal.reasoning}`);
        const fromToken = candidate.fromSymbol === "HBAR" ? undefined : rawPortfolio.tokens.find((token) => token.symbol.toUpperCase() === candidate.fromSymbol);
        const toToken = candidate.toSymbol === "HBAR" ? undefined : rawPortfolio.tokens.find((token) => token.symbol.toUpperCase() === candidate.toSymbol);
        const fromDecimals = candidate.fromSymbol === "HBAR" ? 8 : fromToken?.decimals;
        const toDecimals = candidate.toSymbol === "HBAR" ? 8 : toToken?.decimals ?? 6;
        if (fromDecimals === undefined) throw new Error(`Cannot quote ${candidate.fromSymbol}: token decimals are unavailable`);
        const amountIn = BigInt(Math.floor(proposal.amountFormatted * 10 ** fromDecimals));
        const dexConfig = saucerConfig(this.config);
        think(`Checking the live exchange rate for ${candidate.fromSymbol} → ${candidate.toSymbol} at this size before placing anything.`);
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
            think("Safety checks cleared — market data, band math, and the live exchange quote agree. Sending the swap from the agent treasury.");
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
            think(`Swap confirmed: ${proposal.amountFormatted.toFixed(4)} ${proposal.fromSymbol} → about ${Number(quote.expectedAmountOutFormatted).toFixed(4)} ${proposal.toSymbol}.`);
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
              think(`Holdings updated after the swap: ${mix}.`);
            } catch {
              think("The swap confirmed, but I could not refresh live balances yet — the next check-in will pick them up.");
            }
          } else {
            think("I prepared an exchange quote and paused for your approval — nothing moves until you confirm.");
            const pending: PendingTrade = { id: randomUUID(), runId, accountId, proposal, quote, builtTransaction, createdAt: new Date().toISOString(), status: "pending" };
            store.addPendingTrade(pending, profileId); record.pendingTradeIds.push(pending.id); record.status = "waiting_approval";
          }
        } else {
          think(`I held the sale back: ${policy.reason}`);
        }
      } else {
        think("Your mix looks healthy after the paid reads — no rebalance needed this cycle.");
      }
      if (record.status !== "waiting_approval") record.status = "completed";
      record.completedAt = new Date().toISOString();
      const snapshot = record.portfolioAfter ?? portfolio;
      const hbar = snapshot.allocations.find((allocation) => allocation.symbol === "HBAR");
      const traded = record.tradeExecutions[0];
      const pending = record.status === "waiting_approval" || record.pendingTradeIds.length > 0;
      const conclusion = traded
        ? `Conclusion: rebalanced — ${traded.amountInFormatted} ${traded.fromSymbol} → ${traded.amountOutFormatted ?? "?"} ${traded.toSymbol}.`
        : pending
          ? `Conclusion: prepared a rebalance and paused for your approval.`
          : record.tradeProposals[0]
            ? `Conclusion: evaluated a rebalance but did not execute — ${record.events.find((item) => item.kind === "trade.skipped")?.detail ?? recommendation.summary}`
            : `Conclusion: ${recommendation.summary}`;
      conclude(record, conclusion, [
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
