import type { AllocationBand, AllocationCandidate, Portfolio, PortfolioAllocation } from "./types.js";

/** Minimum absolute target drift (percentage points) before a target-seeking swap is proposed. */
export const DEFAULT_TARGET_DRIFT_PCT = 5;
/** Floor USD size hint when building a user-requested sample swap. */
const MIN_SAMPLE_USD = 2;

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
 * newest paid price snapshot and/or an explicit USD price map (display quotes).
 */
export function mergeLivePortfolioValuation(
  live: Portfolio,
  valuation?: Portfolio,
  pricesUsd: Readonly<Record<string, number>> = {},
  priceProvenance?: string,
): { totalUsd: number; provenance: string; valued: boolean; assets: LiveValuedAsset[] } {
  const fromValuation = valuation ? pricesUsdFromPortfolio(valuation) : {};
  const prices = { ...fromValuation, ...pricesUsd };
  const markProvenance = priceProvenance
    ?? (valuation ? valuation.provenance : live.provenance);
  const assets = live.allocations.map((asset) => {
    const price = prices[asset.symbol.toUpperCase()];
    const usdValue = price !== undefined ? asset.balanceFormatted * price : 0;
    return {
      symbol: asset.symbol,
      balance: asset.balanceFormatted,
      usdValue,
      allocationPct: 0,
      provenance: price !== undefined ? markProvenance : live.provenance,
    };
  });
  const totalUsd = assets.reduce((sum, asset) => sum + asset.usdValue, 0);
  for (const asset of assets) {
    asset.allocationPct = totalUsd > 0 ? (asset.usdValue / totalUsd) * 100 : 0;
  }
  return {
    totalUsd,
    provenance: totalUsd > 0 ? markProvenance : live.provenance,
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

type BandRow = {
  band: AllocationBand;
  allocation?: PortfolioAllocation;
  pct: number;
  excessOverMax: number;
  deficitUnderMin: number;
  driftFromTarget: number;
};

function swapCandidate(
  from: BandRow,
  to: BandRow,
  movedPctOfPortfolio: number,
  total: number,
  reason: string,
): AllocationCandidate {
  if (!from.allocation || movedPctOfPortfolio <= 0) {
    return { action: "hold", percentage: 0, amountUsd: 0, reason: "All allocation bands are satisfied." };
  }
  const amountUsd = total * (movedPctOfPortfolio / 100);
  if (amountUsd <= 0 || from.allocation.usdValue <= 0) {
    return { action: "hold", percentage: 0, amountUsd: 0, reason: "All allocation bands are satisfied." };
  }
  return {
    action: "swap",
    fromSymbol: from.band.symbol,
    toSymbol: to.band.symbol,
    percentage: (amountUsd / from.allocation.usdValue) * 100,
    amountUsd,
    reason,
  };
}

function holdSnapshot(rows: readonly BandRow[]): AllocationCandidate {
  const detail = rows
    .map((row) => `${row.band.symbol} ${row.pct.toFixed(1)}% (target ${row.band.targetPct}%, band ${row.band.minPct}–${row.band.maxPct}%)`)
    .join("; ");
  return {
    action: "hold",
    percentage: 0,
    amountUsd: 0,
    reason: `All allocation bands are satisfied. Current mix: ${detail}.`,
  };
}

/**
 * Returns only the deterministic candidate; it never makes an authorization decision.
 *
 * Priority:
 * 1. Hard ceiling breach — lighten into the deepest under-floor (or under-target) sleeve.
 * 2. Hard floor breach alone — fund from the most overweight sleeve.
 * 3. Target drift — when one asset is ≥ drift above target and another ≥ drift below.
 */
export function proposeBandRebalance(
  allocations: readonly PortfolioAllocation[],
  bands: readonly AllocationBand[],
  options: { targetDriftPct?: number } = {},
): AllocationCandidate {
  validateAllocationBands(bands);
  const indexed = new Map(allocations.map((item) => [item.symbol.toUpperCase(), item]));
  const total = allocations.reduce((sum, item) => sum + item.usdValue, 0);
  if (!Number.isFinite(total) || total <= 0) return { action: "hold", percentage: 0, amountUsd: 0, reason: "Portfolio has no live USD value." };

  const rows: BandRow[] = bands.map((band) => {
    const allocation = indexed.get(band.symbol);
    const pct = allocation?.allocationPct ?? 0;
    return {
      band,
      ...(allocation ? { allocation } : {}),
      pct,
      excessOverMax: pct - band.maxPct,
      deficitUnderMin: band.minPct - pct,
      driftFromTarget: pct - band.targetPct,
    };
  });

  const overMax = rows
    .filter((row) => row.excessOverMax > 0 && row.allocation)
    .sort((a, b) => b.excessOverMax - a.excessOverMax)[0];
  const underMin = rows
    .filter((row) => row.deficitUnderMin > 0)
    .sort((a, b) => b.deficitUnderMin - a.deficitUnderMin)[0];

  if (overMax?.allocation) {
    const underTarget = rows
      .filter((row) => row.band.symbol !== overMax.band.symbol && row.driftFromTarget < 0)
      .sort((a, b) => a.driftFromTarget - b.driftFromTarget)[0];
    const under = underMin && underMin.band.symbol !== overMax.band.symbol ? underMin : underTarget;
    if (under) {
      const towardTargetPct = Math.max(0, overMax.driftFromTarget);
      const receiverNeed = underMin && under.band.symbol === underMin.band.symbol
        ? underMin.deficitUnderMin
        : Math.max(0, -under.driftFromTarget);
      const movedPct = Math.min(overMax.excessOverMax, Math.max(receiverNeed, towardTargetPct));
      const reason = underMin && under.band.symbol === underMin.band.symbol
        ? `${overMax.band.symbol} exceeds its ${overMax.band.maxPct}% ceiling while ${under.band.symbol} is below its ${under.band.minPct}% floor.`
        : `${overMax.band.symbol} exceeds its ${overMax.band.maxPct}% ceiling; rotating toward under-target ${under.band.symbol} (${under.pct.toFixed(1)}% vs ${under.band.targetPct}% target).`;
      return swapCandidate(overMax, under, movedPct, total, reason);
    }
  }

  if (underMin) {
    const over = rows
      .filter((row) => row.band.symbol !== underMin.band.symbol && row.allocation)
      .sort((a, b) => b.driftFromTarget - a.driftFromTarget)[0];
    if (over?.allocation) {
      return swapCandidate(
        over,
        underMin,
        underMin.deficitUnderMin,
        total,
        `${underMin.band.symbol} is below its ${underMin.band.minPct}% floor; funding it from ${over.band.symbol}, the most overweight holding.`,
      );
    }
  }

  const driftPct = options.targetDriftPct ?? DEFAULT_TARGET_DRIFT_PCT;
  const mostOver = rows
    .filter((row) => row.allocation && row.driftFromTarget >= driftPct)
    .sort((a, b) => b.driftFromTarget - a.driftFromTarget)[0];
  const mostUnder = rows
    .filter((row) => row.driftFromTarget <= -driftPct)
    .sort((a, b) => a.driftFromTarget - b.driftFromTarget)[0];
  if (mostOver && mostUnder && mostOver.band.symbol !== mostUnder.band.symbol) {
    return swapCandidate(
      mostOver,
      mostUnder,
      Math.min(mostOver.driftFromTarget, -mostUnder.driftFromTarget),
      total,
      `${mostOver.band.symbol} is ${mostOver.driftFromTarget.toFixed(1)}pp above its ${mostOver.band.targetPct}% target while ${mostUnder.band.symbol} is ${(-mostUnder.driftFromTarget).toFixed(1)}pp below its ${mostUnder.band.targetPct}% target.`,
    );
  }

  return holdSnapshot(rows);
}

/**
 * When the user explicitly asks to trade (Mode 3 approve / Mode 4 execute),
 * surface a concrete swap. If they named a pair (or the model picked one),
 * honor that before soft band nudges so "swap HBAR into USDC" is not rewritten.
 */
export function proposeRequestedTrade(
  allocations: readonly PortfolioAllocation[],
  bands: readonly AllocationBand[],
  preferred?: { fromSymbol: string; toSymbol: string; reason: string; force?: boolean },
): AllocationCandidate {
  validateAllocationBands(bands);
  const indexed = new Map(allocations.map((item) => [item.symbol.toUpperCase(), item]));
  const total = allocations.reduce((sum, item) => sum + item.usdValue, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return { action: "hold", percentage: 0, amountUsd: 0, reason: "Portfolio has no live USD value." };
  }

  const rows: BandRow[] = bands.map((band) => {
    const allocation = indexed.get(band.symbol);
    const pct = allocation?.allocationPct ?? 0;
    return {
      band,
      ...(allocation ? { allocation } : {}),
      pct,
      excessOverMax: pct - band.maxPct,
      deficitUnderMin: band.minPct - pct,
      driftFromTarget: pct - band.targetPct,
    };
  });

  const pairFromPreferred = (): AllocationCandidate | null => {
    if (!preferred?.fromSymbol || !preferred?.toSymbol) return null;
    const from = rows.find((row) => row.band.symbol === preferred.fromSymbol.toUpperCase());
    const to = rows.find((row) => row.band.symbol === preferred.toSymbol.toUpperCase());
    if (!from?.allocation || !to || from.band.symbol === to.band.symbol) return null;
    if (!(from.allocation.usdValue > 0 && from.allocation.balanceFormatted > 0)) return null;
    const movedPct = Math.min(2, Math.max(1, total > 0 ? (Math.max(2, MIN_SAMPLE_USD) / total) * 100 : 1));
    return swapCandidate(from, to, movedPct, total, preferred.reason);
  };

  // User-named / model-picked pair wins over soft drift (hard ceiling breaches still win unless forced).
  if (preferred?.force) {
    const forced = pairFromPreferred();
    if (forced?.action === "swap") return forced;
  }

  const required = proposeBandRebalance(allocations, bands);
  if (required.action === "swap" && !preferred?.force) return required;

  const preferredCandidate = pairFromPreferred();
  if (preferredCandidate?.action === "swap") return preferredCandidate;

  const soft = proposeBandRebalance(allocations, bands, { targetDriftPct: 0.5 });
  if (soft.action === "swap") {
    return {
      ...soft,
      reason: `You asked for a trade. ${soft.reason} Approve to nudge the book toward targets.`,
    };
  }

  const from = rows
    .filter((row) => row.allocation && row.allocation.usdValue > 0)
    .sort((a, b) => b.pct - a.pct || b.driftFromTarget - a.driftFromTarget)[0];
  const to = rows
    .filter((row) => row.band.symbol !== from?.band.symbol)
    .sort((a, b) => a.pct - b.pct || a.driftFromTarget - b.driftFromTarget)[0];

  if (!from?.allocation || !to) {
    return holdSnapshot(rows);
  }

  const movedPct = Math.min(2, Math.max(0.5, from.pct * 0.05));
  return swapCandidate(
    from,
    to,
    movedPct,
    total,
    `You asked for a trade. The book is already near targets, so this is a small ${from.band.symbol} → ${to.band.symbol} tranche (~${movedPct.toFixed(1)}% of portfolio) for you to review and approve.`,
  );
}
