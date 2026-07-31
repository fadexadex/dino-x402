import type { AllocationBand, AllocationCandidate, Portfolio, PortfolioAllocation } from "./types.js";

export function valuePortfolio(portfolio: Portfolio, pricesUsd: Readonly<Record<string, number>>): Portfolio {
  const allocations = portfolio.allocations.map((allocation) => {
    const price = pricesUsd[allocation.symbol.toUpperCase()];
    if (!Number.isFinite(price) || price === undefined || price < 0) throw new Error(`Missing live USD valuation for ${allocation.symbol}`);
    return { ...allocation, usdValue: allocation.balanceFormatted * price, markPriceUsd: price };
  });
  const totalUsdValue = allocations.reduce((sum, allocation) => sum + allocation.usdValue, 0);
  return { ...portfolio, totalUsdValue, allocations: allocations.map((allocation) => ({ ...allocation, allocationPct: totalUsdValue ? allocation.usdValue / totalUsdValue * 100 : 0 })) };
}

/** Recover per-asset USD prices from a previously valued portfolio snapshot. */
export function pricesUsdFromPortfolio(portfolio: Portfolio): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const allocation of portfolio.allocations) {
    const key = allocation.symbol.toUpperCase();
    if (typeof allocation.markPriceUsd === "number" && Number.isFinite(allocation.markPriceUsd) && allocation.markPriceUsd >= 0) {
      prices[key] = allocation.markPriceUsd;
      continue;
    }
    const balance = allocation.balanceFormatted;
    if (balance > 1e-12 && Number.isFinite(allocation.usdValue) && allocation.usdValue >= 0) {
      prices[key] = allocation.usdValue / balance;
    }
  }
  if (prices.USDC === undefined) prices.USDC = 1;
  return prices;
}

export type LiveValuedAsset = {
  symbol: string;
  balance: number;
  usdValue: number;
  allocationPct: number;
  provenance: string;
};

/**
 * Keep Mirror Node balances authoritative, but revalue USD / mix % from the
 * newest paid price snapshot (prefer post-swap valuation when present).
 */
export function mergeLivePortfolioValuation(
  live: Portfolio,
  valuation?: Portfolio,
): { totalUsd: number; provenance: string; valued: boolean; assets: LiveValuedAsset[] } {
  const prices = valuation ? pricesUsdFromPortfolio(valuation) : {};
  const assets = live.allocations.map((asset) => {
    const price = prices[asset.symbol.toUpperCase()];
    const usdValue = price !== undefined ? asset.balanceFormatted * price : 0;
    return {
      symbol: asset.symbol,
      balance: asset.balanceFormatted,
      usdValue,
      allocationPct: 0,
      provenance: price !== undefined && valuation ? valuation.provenance : live.provenance,
    };
  });
  const totalUsd = assets.reduce((sum, asset) => sum + asset.usdValue, 0);
  for (const asset of assets) {
    asset.allocationPct = totalUsd > 0 ? (asset.usdValue / totalUsd) * 100 : 0;
  }
  return {
    totalUsd,
    provenance: totalUsd > 0 && valuation ? valuation.provenance : live.provenance,
    valued: totalUsd > 0,
    assets,
  };
}

export function validateAllocationBands(bands: readonly AllocationBand[]): void {
  if (bands.length === 0) throw new Error("At least one allocation band is required");
  const seen = new Set<string>();
  let targetTotal = 0;
  for (const band of bands) {
    if (seen.has(band.symbol)) throw new Error(`Duplicate allocation band: ${band.symbol}`);
    seen.add(band.symbol);
    if (![band.minPct, band.targetPct, band.maxPct].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) {
      throw new Error(`Invalid allocation limits for ${band.symbol}`);
    }
    if (band.minPct > band.targetPct || band.targetPct > band.maxPct) throw new Error(`Allocation limits out of order for ${band.symbol}`);
    targetTotal += band.targetPct;
  }
  if (Math.abs(targetTotal - 100) > 0.001) throw new Error("Allocation targets must total 100%");
}

/** Returns only the deterministic candidate; it never makes an authorization decision. */
export function proposeBandRebalance(
  allocations: readonly PortfolioAllocation[],
  bands: readonly AllocationBand[],
): AllocationCandidate {
  validateAllocationBands(bands);
  const indexed = new Map(allocations.map((item) => [item.symbol.toUpperCase(), item]));
  const total = allocations.reduce((sum, item) => sum + item.usdValue, 0);
  if (!Number.isFinite(total) || total <= 0) return { action: "hold", percentage: 0, amountUsd: 0, reason: "Portfolio has no live USD value." };
  const over = bands
    .map((band) => ({ band, allocation: indexed.get(band.symbol), excess: (indexed.get(band.symbol)?.allocationPct ?? 0) - band.maxPct }))
    .filter((item) => item.excess > 0 && item.allocation)
    .sort((a, b) => b.excess - a.excess)[0];
  const underFloor = bands
    .map((band) => ({ band, allocation: indexed.get(band.symbol), deficit: band.minPct - (indexed.get(band.symbol)?.allocationPct ?? 0) }))
    .filter((item) => item.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit)[0];
  // If nothing is under its hard floor, still lighten an over-ceiling sleeve into
  // the sleeve furthest below its target (even when that sleeve is above minPct).
  const underTarget = bands
    .map((band) => ({
      band,
      allocation: indexed.get(band.symbol),
      deficit: band.targetPct - (indexed.get(band.symbol)?.allocationPct ?? 0),
    }))
    .filter((item) => item.deficit > 0 && item.band.symbol !== over?.band.symbol)
    .sort((a, b) => b.deficit - a.deficit)[0];
  const under = underFloor ?? underTarget;
  if (!over || !under || !over.allocation) return { action: "hold", percentage: 0, amountUsd: 0, reason: "All allocation bands are satisfied." };
  // When a sleeve is over its ceiling, move toward target (not only the tiny
  // amount needed to kiss the underweight floor). Cap by the ceiling excess.
  const towardTargetPct = Math.max(0, over.allocation.allocationPct - over.band.targetPct);
  const receiverNeed = underFloor ? underFloor.deficit : under.deficit;
  const movedPct = Math.min(over.excess, Math.max(receiverNeed, towardTargetPct));
  const amountUsd = total * (movedPct / 100);
  const reason = underFloor
    ? `${over.band.symbol} exceeds its ${over.band.maxPct}% ceiling while ${under.band.symbol} is below its ${under.band.minPct}% floor.`
    : `${over.band.symbol} exceeds its ${over.band.maxPct}% ceiling; rotating toward under-target ${under.band.symbol} (${(indexed.get(under.band.symbol)?.allocationPct ?? 0).toFixed(1)}% vs ${under.band.targetPct}% target).`;
  return {
    action: "swap", fromSymbol: over.band.symbol, toSymbol: under.band.symbol,
    percentage: (amountUsd / over.allocation.usdValue) * 100, amountUsd,
    reason,
  };
}
