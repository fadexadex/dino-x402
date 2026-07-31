import type { AllocationBand, AllocationCandidate, Portfolio, PortfolioAllocation } from "./types.js";

export function valuePortfolio(portfolio: Portfolio, pricesUsd: Readonly<Record<string, number>>): Portfolio {
  const allocations = portfolio.allocations.map((allocation) => {
    const price = pricesUsd[allocation.symbol.toUpperCase()];
    if (!Number.isFinite(price) || price === undefined || price < 0) throw new Error(`Missing live USD valuation for ${allocation.symbol}`);
    return { ...allocation, usdValue: allocation.balanceFormatted * price };
  });
  const totalUsdValue = allocations.reduce((sum, allocation) => sum + allocation.usdValue, 0);
  return { ...portfolio, totalUsdValue, allocations: allocations.map((allocation) => ({ ...allocation, allocationPct: totalUsdValue ? allocation.usdValue / totalUsdValue * 100 : 0 })) };
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
  const under = bands
    .map((band) => ({ band, allocation: indexed.get(band.symbol), deficit: band.minPct - (indexed.get(band.symbol)?.allocationPct ?? 0) }))
    .filter((item) => item.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit)[0];
  if (!over || !under || !over.allocation) return { action: "hold", percentage: 0, amountUsd: 0, reason: "All allocation bands are satisfied." };
  const movedPct = Math.min(over.excess, under.deficit);
  const amountUsd = total * (movedPct / 100);
  return {
    action: "swap", fromSymbol: over.band.symbol, toSymbol: under.band.symbol,
    percentage: (amountUsd / over.allocation.usdValue) * 100, amountUsd,
    reason: `${over.band.symbol} exceeds its ${over.band.maxPct}% ceiling while ${under.band.symbol} is below its ${under.band.minPct}% floor.`,
  };
}
