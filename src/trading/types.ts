export interface SwapQuote {
  fromToken: string;
  fromSymbol: string;
  toToken: string;
  toSymbol: string;
  amountIn: bigint;
  amountInFormatted: number;
  expectedAmountOut: bigint;
  expectedAmountOutFormatted: number;
  priceImpact?: number;
  route: string[];
  quotedAt?: string;
  amountOutMinimum?: bigint;
  provenance?: "live" | "cached" | "fallback" | "stale";
}

export interface SwapParams {
  fromToken: string;
  fromSymbol: string;
  toToken: string;
  toSymbol: string;
  amountIn: bigint;
  minAmountOut: bigint;
  slippageBps: number;
}

export interface SwapResult {
  success: boolean;
  transactionId: string;
  hashscanUrl: string;
  fromToken: string;
  fromSymbol: string;
  toToken: string;
  toSymbol: string;
  amountIn: bigint;
  amountInFormatted: number;
  amountOut?: bigint;
  amountOutFormatted?: number;
  error?: string;
}

export interface SwapVerification {
  confirmed: boolean;
  transactionId: string;
  status: string;
  transfers: Array<{
    account: string;
    amount: number;
    token?: string;
  }>;
}

export interface TradeProposal {
  action: "swap" | "hold";
  fromSymbol: string;
  toSymbol: string;
  percentage: number;
  amountFormatted: number;
  reasoning: string;
  confidence: number;
  source: "mistral" | "deterministic";
  fallbackReason?: string;
}

export interface TradePolicyConfig {
  maxTradeAmountTinybar: bigint;
  maxSlippageBps: number;
  allowedSymbols?: string[];
  maxTradePct?: number;
  maxPortfolioMovePct?: number;
  maxPriceImpactBps?: number;
  maxTradesPerDay?: number;
  maxDailyTradePct?: number;
  minTradeUsd?: number;
}

export interface TradePolicyContext {
  availableBalance: number;
  portfolioUsd: number;
  amountUsd: number;
  todayTradeUsd?: number;
  tradesToday?: number;
  quote?: SwapQuote;
  provenance?: "live" | "cached" | "fallback" | "stale";
  halted?: boolean;
  quoteMaxAgeMs?: number;
}

export interface SaucerSwapConfig {
  routerId: string;
  quoterId: string;
  whbarTokenId: string;
  tokenIds: Record<"HBAR" | "USDC" | "SAUCE", string>;
  feeTier: number;
}

export interface BuiltSwapTransaction {
  contractId: string;
  functionName: "exactInput" | "multicall";
  encodedParameters: Uint8Array;
  amountTinybar: bigint;
  deadline: number;
  amountOutMinimum: bigint;
  route: string[];
}
