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

const ASSETS = ["HBAR", "USDC", "SAUCE"] as const;
const DEFAULT_BANDS = [
  { symbol: "HBAR" as const, minPct: 25, targetPct: 34, maxPct: 45 },
  { symbol: "USDC" as const, minPct: 25, targetPct: 33, maxPct: 45 },
  { symbol: "SAUCE" as const, minPct: 10, targetPct: 33, maxPct: 40 },
];

function paidSignal(data: unknown): { price?: number; provenance: "live" | "fallback" } | undefined {
  if (!data || typeof data !== "object") return undefined;
  const outer = data as Record<string, unknown>;
  const inner = outer.data && typeof outer.data === "object" ? outer.data as Record<string, unknown> : outer;
  const value = inner.price ?? inner.close;
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
      minTradeUsd: 0.5,
      allowedSymbols: ["HBAR", "USDC", "SAUCE"],
    });
  }

  async runMultiAsset(inputAccount?: string, input: { objective?: string; idempotencyKey?: string; profileId?: string } = {}): Promise<AgentMultiRunRecord> {
    const runId = randomUUID();
    const state = store.getState();
    const accountId = inputAccount ?? state.account?.accountId ?? state.profiles?.find((profile) => profile.kind === "agent_managed")?.accountId;
    if (!accountId) throw new Error("A real Hedera account must be connected before running the agent");
    const profileId = input.profileId
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
      event("portfolio.read", "Reading live portfolio", `Fetching Mirror Node holdings for ${accountId}`);
      const rawPortfolio = await readPortfolio(accountId);
      record.portfolioBefore = rawPortfolio; store.updateRun(runId, { portfolioBefore: rawPortfolio }, profileId);
      const mode = state.profiles?.find((profile) => profile.id === profileId)?.autonomyMode ?? 3;
      const hbarBal = rawPortfolio.allocations.find((a) => a.symbol.toUpperCase() === "HBAR")?.balanceFormatted;
      think(
        hbarBal === undefined
          ? "Mirror Node returned the live holdings. Next I need paid intelligence for HBAR, USDC, and SAUCE before judging the bands."
          : `Holdings are in — ${hbarBal.toFixed(4)} HBAR on the book, plus any HTS balances. I still need fresh paid prices before any rebalance call.`,
      );
      if (mode === 1) {
        record.recommendation = { summary: "Observe-only mode recorded the live portfolio without purchasing intelligence or proposing a trade.", action: "watch", confidence: 1, rationale: ["Autonomy mode 1"], source: "deterministic" };
        record.status = "completed"; record.completedAt = new Date().toISOString();
        think("Mode 1 is observe-only, so I stop after recording the portfolio — no paid reads and no trade proposal.");
        event("analysis.completed", "Observe-only check-in complete", record.recommendation.summary);
        conclude(record, "Conclusion: observed the live portfolio only — no paid CoinGecko reads and no trade.", [
          `Account ${accountId} was read from Mirror Node.`,
          "Autonomy mode 1 forbids intelligence purchases and execution.",
        ]);
        store.updateRun(runId, record, profileId);
        sseBroadcaster.broadcast("agent.completed", { runId, record }, { profileId, runId });
        return record;
      }
      const prices: Record<string, number> = {};
      const selected = ASSETS.filter((symbol) => state.schedule.watchedSymbols.length === 0 || state.schedule.watchedSymbols.includes(symbol));
      if (selected.length !== ASSETS.length) throw new Error("HBAR, USDC, and SAUCE must all have live intelligence before allocation decisions");
      let spend = 0n;
      const cycleBudget = BigInt(Math.floor(state.schedule.dataBudgetHbar * 1e8));
      const dailyBudget = BigInt(Math.floor(state.schedule.dailyBudgetCapHbar * 1e8));
      const alreadySpentToday = BigInt(Math.floor(state.spending.todayDataHbar * 1e8));
      for (const symbol of selected) {
        const cached = this.signalCache.get(symbol);
        if (cached && Date.now() - cached.at < 60_000) {
          prices[symbol] = cached.price;
          think(`${symbol} still has a paid CoinGecko signal inside its freshness window — reusing $${cached.price} instead of spending again.`);
          event("data.received", `${symbol} intelligence reused`, `Reused paid CoinGecko signal at $${cached.price}.`, { provenance: "cached", price: cached.price, symbol });
          // Keep a chartable observation so cache-hit runs still move the graph.
          if (cached.data) {
            record.dataPurchases.push({
              symbol,
              productId: cached.productId ?? "spot-price",
              amountHbar: 0,
              transactionId: `cache:${runId}:${symbol}`,
              hashscanUrl: cached.hashscanUrl ?? "",
              data: cached.data,
            });
          }
          continue;
        }
        const remainingCycle = cycleBudget - spend;
        const remainingDaily = dailyBudget - alreadySpentToday - spend;
        const remaining = remainingCycle < remainingDaily ? remainingCycle : remainingDaily;
        if (remaining <= 0n) throw new Error("x402 data budget exhausted before all required asset signals were acquired");
        think(`Buying a live ${symbol} CoinGecko signal through x402 so the valuation stays on-chain and independently verifiable.`);
        event("payment.required", `Buying ${symbol} intelligence`, "Requesting a real x402 quote for CoinGecko market data.");
        const result = await this.intelligence.run({ symbol, objective: record.objective, portfolio: [], budgetAtomic: remaining.toString() });
        if (result.status !== "completed" || !result.purchase) throw new Error(`Unable to obtain verified paid intelligence for ${symbol}: ${result.error ?? "unknown error"}`);
        if (result.plan?.reason) {
          think(result.plan.reason);
        }
        for (const nested of result.events) {
          if (nested.kind === "payment.authorized" || nested.kind === "payment.settled") {
            think(nested.detail || nested.title);
          }
        }
        const signal = paidSignal(result.purchase.data);
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
        event("payment.settled", `${symbol} payment verified`, `CoinGecko ${symbol} @ $${signal.price} · x402 receipt ${result.purchase.transactionId}`, { transactionId: result.purchase.transactionId, hashscanUrl: result.purchase.hashscanUrl, provenance: signal.provenance, price: signal.price, symbol });
        think(`${symbol} settled at $${signal.price} from CoinGecko (${signal.provenance}). Receipt ${result.purchase.transactionId} is on HashScan.`);
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
      think("All three paid prices are in. Comparing each sleeve against its allocation band next.");
      const candidate = proposeBandRebalance(portfolio.allocations, DEFAULT_BANDS);
      const recommendation: AgentRecommendation = { summary: candidate.reason, action: candidate.action === "swap" ? "rebalance" : "watch", confidence: 1, rationale: ["Deterministic allocation-band evaluation", "All three values were paid x402 live signals", candidate.reason], source: "deterministic" };
      record.recommendation = recommendation;
      for (const line of recommendation.rationale) think(line);
      event("analysis.completed", "Deterministic portfolio evaluation", recommendation.summary, { recommendation });
      if (mode === 2) {
        think("Mode 2 stops at advice — recording the recommendation without proposing an executable order.");
        record.status = "completed"; record.completedAt = new Date().toISOString();
        conclude(record, `Conclusion: ${recommendation.summary}`, [
          `Paid/reused CoinGecko prices for ${Object.keys(prices).join(", ")}.`,
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
        const hbarAtomicCapPct = candidate.fromSymbol === "HBAR" && source?.balanceFormatted
          ? Number(BigInt(this.config.tradeMaxAmountTinybar ?? "1000000000")) / 1e8 / source.balanceFormatted * 100
          : configuredMaxPct;
        const executablePct = Math.min(candidate.percentage, configuredMaxPct, hbarAtomicCapPct);
        const proposal: TradeProposal = { action: "swap", fromSymbol: candidate.fromSymbol, toSymbol: candidate.toSymbol, percentage: executablePct, amountFormatted: source ? source.balanceFormatted * executablePct / 100 : 0, reasoning: `${candidate.reason} The executable tranche is capped by portfolio policy.`, confidence: 1, source: "deterministic" };
        record.tradeProposals = [proposal];
        think(proposal.reasoning);
        const fromToken = candidate.fromSymbol === "HBAR" ? undefined : rawPortfolio.tokens.find((token) => token.symbol.toUpperCase() === candidate.fromSymbol);
        const toToken = candidate.toSymbol === "HBAR" ? undefined : rawPortfolio.tokens.find((token) => token.symbol.toUpperCase() === candidate.toSymbol);
        const fromDecimals = candidate.fromSymbol === "HBAR" ? 8 : fromToken?.decimals;
        const toDecimals = candidate.toSymbol === "HBAR" ? 8 : toToken?.decimals ?? 6;
        if (fromDecimals === undefined) throw new Error(`Cannot quote ${candidate.fromSymbol}: token decimals are unavailable`);
        const amountIn = BigInt(Math.floor(proposal.amountFormatted * 10 ** fromDecimals));
        const dexConfig = saucerConfig(this.config);
        think(`Asking SaucerSwap QuoterV2 for an executable ${candidate.fromSymbol} → ${candidate.toSymbol} route.`);
        const quote = await quoteSaucerExactInput({
          fromSymbol: candidate.fromSymbol, toSymbol: candidate.toSymbol, amountIn,
          amountInFormatted: proposal.amountFormatted, expectedAmountOutFormatted: 0,
          config: dexConfig,
          quoter: createMirrorExactInputQuoter({ mirrorBaseUrl: this.config.mirrorNodeBaseUrl, config: dexConfig }),
        });
        quote.expectedAmountOutFormatted = Number(quote.expectedAmountOut) / 10 ** toDecimals;
        quote.amountOutMinimum = quote.expectedAmountOut * BigInt(10_000 - Number(this.config.tradeSlippageBps ?? "100")) / 10_000n;
        const provenance = Array.from(this.signalCache.values()).some((signal) => signal.provenance === "fallback") ? "fallback" : "live";
        const amountUsd = (source?.usdValue ?? 0) * executablePct / 100;
        const policy = this.tradePolicy.validate(proposal, { availableBalance: source?.balanceFormatted ?? 0, portfolioUsd: portfolio.totalUsdValue ?? 0, amountUsd, provenance, halted: store.isHalted(), quote });
        event(policy.approved ? "trade.proposed" : "trade.skipped", policy.approved ? "Trade proposed" : "Trade blocked", policy.reason, { proposal });
        if (policy.approved) {
          const builtTransaction = buildExactInputTransaction({
            quote,
            recipientSolidityAddress: await resolveAccountEvmAddress(accountId, { mirrorBaseUrl: this.config.mirrorNodeBaseUrl }),
            slippageBps: Number(this.config.tradeSlippageBps ?? "100"), config: dexConfig, ttlSeconds: 600,
          });
          const canExecuteAutonomously = state.schedule.autonomousTrading && accountId === this.config.agentPayerId && Boolean(this.config.agentPayerKey);
          if (canExecuteAutonomously) {
            event("trade.approved", "Trade passed autonomous policy", "Submitting the verified SaucerSwap V2 call.", { quote, presentInUi: true });
            think("Policy cleared the order. Submitting the SaucerSwap V2 call from the agent treasury and waiting for Hedera consensus.");
            event("trade.submitted", "Trade submitted", "Awaiting Hedera consensus for the SaucerSwap call.", { quote });
            const result = await executeSaucerSwap({ payerId: accountId, payerKey: this.config.agentPayerKey!, quote, transaction: builtTransaction, mirrorBaseUrl: this.config.mirrorNodeBaseUrl });
            record.tradeExecutions.push(result);
            store.recordSpend(0, proposal.amountFormatted, profileId);
            event("trade.verified", "Trade verified on Hedera", `${proposal.amountFormatted} ${proposal.fromSymbol} → ${quote.expectedAmountOutFormatted} ${proposal.toSymbol}`, { result, transactionId: result.transactionId });
            think(`Swap verified: ${proposal.amountFormatted} ${proposal.fromSymbol} → ${quote.expectedAmountOutFormatted} ${proposal.toSymbol}.`);
          } else {
            think("I prepared an executable quote and paused for approval — nothing moves until you confirm.");
            const pending: PendingTrade = { id: randomUUID(), runId, accountId, proposal, quote, builtTransaction, createdAt: new Date().toISOString(), status: "pending" };
            store.addPendingTrade(pending, profileId); record.pendingTradeIds.push(pending.id); record.status = "waiting_approval";
          }
        } else {
          think(policy.reason);
        }
      } else {
        think("Bands look healthy — no rebalance candidate this cycle.");
      }
      if (record.status !== "waiting_approval") record.status = "completed";
      record.completedAt = new Date().toISOString();
      const hbar = portfolio.allocations.find((allocation) => allocation.symbol === "HBAR");
      const traded = record.tradeExecutions[0];
      const pending = record.status === "waiting_approval" || record.pendingTradeIds.length > 0;
      const conclusion = traded
        ? `Conclusion: rebalanced on-chain — ${traded.amountInFormatted} ${traded.fromSymbol} → ${traded.amountOutFormatted ?? "?"} ${traded.toSymbol}.`
        : pending
          ? `Conclusion: prepared a rebalance and paused for your approval.`
          : record.tradeProposals[0]
            ? `Conclusion: evaluated a rebalance but did not execute — ${record.events.find((item) => item.kind === "trade.skipped")?.detail ?? recommendation.summary}`
            : `Conclusion: ${recommendation.summary}`;
      conclude(record, conclusion, [
        `CoinGecko-backed prices used for ${Object.keys(prices).join(", ")} (${record.dataPurchases.filter((p) => !p.transactionId.startsWith("cache:")).length} paid x402 reads this cycle).`,
        `Portfolio about $${(portfolio.totalUsdValue ?? 0).toFixed(2)}${hbar ? ` · HBAR ${hbar.allocationPct.toFixed(1)}% of book` : ""}.`,
        traded
          ? `Trade verified: ${traded.transactionId}`
          : pending
            ? "Awaiting your approval before any funds move."
            : "No executable trade cleared policy this cycle.",
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
