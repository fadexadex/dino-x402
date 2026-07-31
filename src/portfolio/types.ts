export interface TokenBalance {
  tokenId: string;
  symbol: string;
  name: string;
  balance: bigint;
  decimals: number;
  balanceFormatted: number;
  usdValue?: number;
}

/** The origin of a value is deliberately carried into policy decisions. */
export type DataProvenance = "live" | "cached" | "fallback" | "stale";

export interface PortfolioAllocation {
  symbol: string;
  tokenId?: string;
  balanceFormatted: number;
  usdValue: number;
  allocationPct: number;
  /** Paid USD mark used for this sleeve; kept even when balance is zero. */
  markPriceUsd?: number;
}

export interface Portfolio {
  accountId: string;
  hbarBalance: bigint;
  hbarFormatted: number;
  hbarUsdValue?: number;
  tokens: TokenBalance[];
  totalUsdValue?: number;
  allocations: PortfolioAllocation[];
  fetchedAt: string;
  provenance: DataProvenance;
}

export interface MirrorAccountResponse {
  account: string;
  balance: {
    balance: number;
    timestamp: string;
    tokens: Array<{
      token_id: string;
      balance: number;
    }>;
  };
}

export interface MirrorTokenInfoResponse {
  token_id: string;
  name: string;
  symbol: string;
  decimals: string;
  type: string;
  total_supply: string;
}

export interface AllocationBand {
  symbol: "HBAR" | "USDC" | "SAUCE";
  tokenId?: string;
  minPct: number;
  targetPct: number;
  maxPct: number;
}

export interface AllocationCandidate {
  action: "swap" | "hold";
  fromSymbol?: string;
  toSymbol?: string;
  /** Percentage of the source holding, not the total portfolio. */
  percentage: number;
  amountUsd: number;
  reason: string;
}
