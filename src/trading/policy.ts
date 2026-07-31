import type { TradeProposal, TradePolicyConfig, TradePolicyContext } from "./types.js";

const DEFAULT_MAX_TRADE_TINYBAR = 1_000_000_000n; // 10 HBAR
const DEFAULT_MAX_SLIPPAGE_BPS = 500; // 5%
const DEFAULT_ALLOWED_SYMBOLS = ["HBAR", "USDC", "USDT", "KARATE", "SAUCE"];

export interface PolicyResult {
  approved: boolean;
  reason: string;
}

export class TradePolicy {
  private readonly config: TradePolicyConfig;

  constructor(config?: Partial<TradePolicyConfig>) {
    this.config = {
      ...config,
      maxTradeAmountTinybar: config?.maxTradeAmountTinybar ?? DEFAULT_MAX_TRADE_TINYBAR,
      maxSlippageBps: config?.maxSlippageBps ?? DEFAULT_MAX_SLIPPAGE_BPS,
      allowedSymbols: config?.allowedSymbols ?? DEFAULT_ALLOWED_SYMBOLS,
    };
  }

  validate(proposal: TradeProposal, availableBalanceOrContext: number | TradePolicyContext): PolicyResult {
    const context: TradePolicyContext = typeof availableBalanceOrContext === "number"
      ? { availableBalance: availableBalanceOrContext, portfolioUsd: 0, amountUsd: 0 }
      : availableBalanceOrContext;
    const availableBalance = context.availableBalance;
    if (proposal.action === "hold") {
      return { approved: true, reason: "Hold action requires no trade." };
    }

    if (context.halted) return { approved: false, reason: "Global kill switch is active." };
    if (context.provenance === "fallback" || context.provenance === "stale") return { approved: false, reason: "Fallback or stale market data can never authorize a trade." };
    const allowed = this.config.allowedSymbols ?? DEFAULT_ALLOWED_SYMBOLS;
    if (!allowed.includes(proposal.fromSymbol.toUpperCase())) {
      return {
        approved: false,
        reason: `Token ${proposal.fromSymbol} is not in the allowed trading list.`,
      };
    }
    if (!allowed.includes(proposal.toSymbol.toUpperCase())) return { approved: false, reason: `Token ${proposal.toSymbol} is not in the allowed trading list.` };

    if (proposal.amountFormatted > availableBalance) {
      return {
        approved: false,
        reason: `Trade amount ${proposal.amountFormatted} exceeds available balance ${availableBalance}.`,
      };
    }
    const maxTradePct = this.config.maxTradePct ?? 5;
    if (proposal.percentage > maxTradePct) return { approved: false, reason: `Trade percentage exceeds ${maxTradePct}% limit.` };
    if (context.portfolioUsd > 0 && context.amountUsd / context.portfolioUsd * 100 > (this.config.maxPortfolioMovePct ?? 5)) return { approved: false, reason: "Trade exceeds maximum portfolio movement." };
    if (context.amountUsd > 0 && context.amountUsd < (this.config.minTradeUsd ?? 1)) return { approved: false, reason: "Trade is below the minimum trade value." };
    if ((context.tradesToday ?? 0) >= (this.config.maxTradesPerDay ?? 6)) return { approved: false, reason: "Daily trade count limit reached." };
    if (context.portfolioUsd > 0 && ((context.todayTradeUsd ?? 0) + context.amountUsd) / context.portfolioUsd * 100 > (this.config.maxDailyTradePct ?? 15)) return { approved: false, reason: "Daily trade volume limit reached." };
    if (!context.quote) return { approved: false, reason: "A fresh executable SaucerSwap quote is required." };
    if (context.quote.provenance && context.quote.provenance !== "live") return { approved: false, reason: "Only live executable quotes may authorize a trade." };
    if (context.quote.fromSymbol.toUpperCase() === "HBAR" && context.quote.amountIn > this.config.maxTradeAmountTinybar) {
      return { approved: false, reason: "Trade exceeds the maximum atomic HBAR amount." };
    }
    if (context.quote.amountOutMinimum !== undefined && context.quote.expectedAmountOut > 0n) {
      const slippageBps = Number((context.quote.expectedAmountOut - context.quote.amountOutMinimum) * 10_000n / context.quote.expectedAmountOut);
      if (slippageBps > this.config.maxSlippageBps) return { approved: false, reason: "Quoted slippage exceeds policy." };
    }
    if (context.quote.priceImpact !== undefined && context.quote.priceImpact * 10_000 > (this.config.maxPriceImpactBps ?? 200)) return { approved: false, reason: "Quoted price impact exceeds policy." };
    if (context.quote.quotedAt && Date.now() - Date.parse(context.quote.quotedAt) > (context.quoteMaxAgeMs ?? 30_000)) return { approved: false, reason: "Executable quote is stale." };

    return {
      approved: true,
      reason: `Trade approved: swap ${proposal.percentage}% of ${proposal.fromSymbol} to ${proposal.toSymbol}.`,
    };
  }
}
