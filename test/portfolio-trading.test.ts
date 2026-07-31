import { describe, expect, it } from "vitest";
import { readPortfolio } from "../src/portfolio/reader.js";
import { mergeLivePortfolioValuation, pricesUsdFromPortfolio, proposeBandRebalance, validateAllocationBands, valuePortfolio } from "../src/portfolio/allocation.js";
import { TradePolicy } from "../src/trading/policy.js";
import { buildExactInputTransaction, encodeV2Path, minimumOutput, quoteSaucerExactInput, resolveAccountEvmAddress, resolveSaucerRoute } from "../src/trading/saucerswap.js";
import { verifyMirrorSwap } from "../src/trading/verification.js";
import type { SwapQuote } from "../src/trading/types.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("live portfolio and deterministic allocation", () => {
  it("does not fabricate balances when Mirror Node is unavailable", async () => {
    await expect(readPortfolio("0.0.9999999", { fetchFn: async () => new Response("down", { status: 503 }) })).rejects.toThrow("Unable to read live portfolio");
  });

  it("reads actual atomic balances with live provenance and requires an explicit valuation", async () => {
    const portfolio = await readPortfolio("0.0.9999998", {
      fetchFn: async (url) => String(url).includes("/accounts/")
        ? json({ account: "0.0.9999998", balance: { balance: 123000000, timestamp: "1", tokens: [{ token_id: "0.0.9999997", balance: 2500000 }] } })
        : json({ token_id: "0.0.9999997", symbol: "SAUCE", name: "SaucerSwap", decimals: "6", type: "FUNGIBLE_COMMON", total_supply: "0" }),
    });
    expect(portfolio.provenance).toBe("live");
    expect(portfolio.hbarFormatted).toBe(1.23);
    expect(portfolio.allocations.every((entry) => entry.usdValue === 0)).toBe(true);
    const valued = valuePortfolio(portfolio, { HBAR: 0.1, SAUCE: 0.5 });
    expect(valued.totalUsdValue).toBeCloseTo(1.373);
  });

  it("proposes selling an oversized sleeve toward target while funding an under-floor asset", () => {
    const candidate = proposeBandRebalance([
      { symbol: "HBAR", balanceFormatted: 80, usdValue: 80, allocationPct: 80 },
      { symbol: "USDC", balanceFormatted: 20, usdValue: 20, allocationPct: 20 },
      { symbol: "SAUCE", balanceFormatted: 0, usdValue: 0, allocationPct: 0 },
    ], [
      { symbol: "HBAR", minPct: 25, targetPct: 34, maxPct: 45 },
      { symbol: "USDC", minPct: 25, targetPct: 33, maxPct: 45 },
      { symbol: "SAUCE", minPct: 10, targetPct: 33, maxPct: 40 },
    ]);
    // HBAR is 35pp over its 45% ceiling and 46pp over target — move the ceiling excess (35%).
    expect(candidate).toMatchObject({ action: "swap", fromSymbol: "HBAR", toSymbol: "SAUCE", amountUsd: 35 });
    expect(() => validateAllocationBands([{ symbol: "HBAR", minPct: 0, targetPct: 99, maxPct: 100 }])).toThrow("total 100%");
  });

  it("revalues live Mirror balances from the latest paid price snapshot after a swap", () => {
    const before = valuePortfolio({
      accountId: "0.0.1",
      fetchedAt: "2026-07-31T12:00:00.000Z",
      provenance: "live",
      hbarBalance: 100_00000000n,
      hbarFormatted: 100,
      tokens: [],
      allocations: [
        { symbol: "HBAR", balanceFormatted: 100, usdValue: 0, allocationPct: 0 },
        { symbol: "USDC", balanceFormatted: 20, usdValue: 0, allocationPct: 0 },
        { symbol: "SAUCE", balanceFormatted: 0, usdValue: 0, allocationPct: 0 },
      ],
    }, { HBAR: 0.2, USDC: 1, SAUCE: 0.01 });
    const prices = pricesUsdFromPortfolio(before);
    expect(prices.HBAR).toBeCloseTo(0.2);
    expect(prices.SAUCE).toBeCloseTo(0.01);
    const liveAfterSwap = {
      ...before,
      hbarFormatted: 90,
      allocations: [
        { symbol: "HBAR", balanceFormatted: 90, usdValue: 0, allocationPct: 0 },
        { symbol: "USDC", balanceFormatted: 20, usdValue: 0, allocationPct: 0 },
        { symbol: "SAUCE", balanceFormatted: 1000, usdValue: 0, allocationPct: 0 },
      ],
    };
    const merged = mergeLivePortfolioValuation(liveAfterSwap, before);
    expect(merged.valued).toBe(true);
    expect(merged.totalUsd).toBeCloseTo(90 * 0.2 + 20 + 1000 * 0.01);
    const sauce = merged.assets.find((asset) => asset.symbol === "SAUCE");
    expect(sauce?.balance).toBe(1000);
    expect(sauce?.allocationPct).toBeGreaterThan(0);
  });

  it("still rotates an over-ceiling sleeve when nothing is under its hard floor", () => {
    const candidate = proposeBandRebalance([
      { symbol: "HBAR", balanceFormatted: 55, usdValue: 55, allocationPct: 55 },
      { symbol: "USDC", balanceFormatted: 35, usdValue: 35, allocationPct: 35 },
      { symbol: "SAUCE", balanceFormatted: 10, usdValue: 10, allocationPct: 10 },
    ], [
      { symbol: "HBAR", minPct: 25, targetPct: 34, maxPct: 45 },
      { symbol: "USDC", minPct: 25, targetPct: 33, maxPct: 45 },
      { symbol: "SAUCE", minPct: 10, targetPct: 33, maxPct: 40 },
    ]);
    expect(candidate.action).toBe("swap");
    expect(candidate.fromSymbol).toBe("HBAR");
    expect(candidate.toSymbol).toBe("SAUCE");
    expect(candidate.amountUsd).toBeCloseTo(10); // 10pp ceiling excess
  });
});

describe("trade guardrails and SaucerSwap plans", () => {
  const quote: SwapQuote = { fromToken: "0.0.0", fromSymbol: "HBAR", toToken: "0.0.2", toSymbol: "USDC", amountIn: 100000000n, amountInFormatted: 1, expectedAmountOut: 1_000_000n, expectedAmountOutFormatted: 1, priceImpact: 0.001, route: ["0.0.1", "0.0.2"], quotedAt: new Date().toISOString(), provenance: "live" };
  const proposal = { action: "swap" as const, fromSymbol: "HBAR", toSymbol: "USDC", percentage: 2, amountFormatted: 1, reasoning: "band breach", confidence: 1, source: "deterministic" as const };
  const context = { availableBalance: 10, portfolioUsd: 100, amountUsd: 2, quote, provenance: "live" as const };

  it("rejects fallback/stale data, missing quotes, daily caps, and high impact", () => {
    const policy = new TradePolicy({ maxTradeAmountTinybar: 1_000_000_000n, maxSlippageBps: 100 });
    expect(policy.validate(proposal, { ...context, provenance: "fallback" }).approved).toBe(false);
    expect(policy.validate(proposal, { ...context, quote: undefined }).reason).toContain("quote");
    expect(policy.validate(proposal, { ...context, tradesToday: 6 }).reason).toContain("Daily trade count");
    expect(policy.validate(proposal, { ...context, quote: { ...quote, priceImpact: 0.03 } }).reason).toContain("price impact");
    expect(policy.validate(proposal, context).approved).toBe(true);
  });

  it("retains extended risk settings supplied to the policy constructor", () => {
    const policy = new TradePolicy({
      maxTradeAmountTinybar: 1_000_000_000n,
      maxSlippageBps: 100,
      maxTradePct: 1,
      minTradeUsd: 0.5,
    });
    expect(policy.validate(proposal, { ...context, amountUsd: 0.75 }).reason).toContain("1% limit");
    expect(policy.validate({ ...proposal, percentage: 1 }, { ...context, amountUsd: 0.49 }).reason).toContain("minimum trade value");
    expect(policy.validate({ ...proposal, percentage: 1 }, { ...context, amountUsd: 0.75 }).approved).toBe(true);
  });

  it("encodes a fixed direct route, minimum output, and a short-lived exact-input plan", () => {
    expect(minimumOutput(1000n, 100)).toBe(990n);
    expect(encodeV2Path(["0.0.1", "0.0.2"], 3000)).toHaveLength(43);
    expect(resolveSaucerRoute("USDC", "SAUCE", { routerId: "0.0.3", quoterId: "0.0.4", whbarTokenId: "0.0.1", tokenIds: { HBAR: "0.0.0", USDC: "0.0.2", SAUCE: "0.0.3" }, feeTier: 3000 })).toEqual(["0.0.2", "0.0.1", "0.0.3"]);
    const plan = buildExactInputTransaction({ quote, recipientSolidityAddress: "0x0000000000000000000000000000000000000001", slippageBps: 100, config: { routerId: "0.0.3", quoterId: "0.0.4", whbarTokenId: "0.0.1", tokenIds: { HBAR: "0.0.0", USDC: "0.0.2", SAUCE: "0.0.3" }, feeTier: 3000 }, nowSeconds: 100 });
    expect(plan).toMatchObject({ contractId: "0.0.3", amountTinybar: 100000000n, amountOutMinimum: 990000n, deadline: 160 });
  });

  it("uses an ECDSA account's Mirror EVM alias instead of its numeric long-zero address", async () => {
    const evm = await resolveAccountEvmAddress("0.0.123", {
      mirrorBaseUrl: "https://mirror.invalid",
      fetchFn: async () => json({ account: "0.0.123", evm_address: "0x2147cc1fca89a2a6dc6baf07b71208a9401e573f" }),
    });
    expect(evm).toBe("0x2147cc1fca89a2a6dc6baf07b71208a9401e573f");
  });

  it("marks an injected on-chain QuoterV2 result live and refuses zero output", async () => {
    const config = { routerId: "0.0.3", quoterId: "0.0.4", whbarTokenId: "0.0.1", tokenIds: { HBAR: "0.0.0", USDC: "0.0.2", SAUCE: "0.0.3" }, feeTier: 3000 };
    const result = await quoteSaucerExactInput({ fromSymbol: "HBAR", toSymbol: "USDC", amountIn: 1n, amountInFormatted: 0.00000001, expectedAmountOutFormatted: 0.1, config, quoter: async () => ({ amountOut: 100000n }) });
    expect(result).toMatchObject({ expectedAmountOut: 100000n, provenance: "live", route: ["0.0.1", "0.0.2"] });
    await expect(quoteSaucerExactInput({ fromSymbol: "HBAR", toSymbol: "USDC", amountIn: 1n, amountInFormatted: 1, expectedAmountOutFormatted: 0, config, quoter: async () => ({ amountOut: 0n }) })).rejects.toThrow("no output");
  });

  it("uses Mirror Node result as the final transaction proof", async () => {
    let requestedUrl = "";
    const proof = await verifyMirrorSwap("0.0.1@1.2", {
      mirrorBaseUrl: "https://mirror.invalid",
      receiverAccountId: "0.0.1",
      outputTokenId: "0.0.2",
      minimumOutput: 990n,
      fetchFn: async (url) => { requestedUrl = String(url); return json({ transactions: [{ transaction_id: "0.0.1@1.2", result: "SUCCESS", token_transfers: [{ token_id: "0.0.2", account: "0.0.1", amount: 1000 }] }] }); },
    });
    expect(proof).toMatchObject({ confirmed: true, status: "SUCCESS", transfers: [{ token: "0.0.2", account: "0.0.1", amount: 1000 }] });
    expect(requestedUrl).toContain("0.0.1-1-2");
    await expect(verifyMirrorSwap("0.0.1@1.2", {
      receiverAccountId: "0.0.1", outputTokenId: "0.0.2", minimumOutput: 1001n,
      fetchFn: async () => json({ transactions: [{ result: "SUCCESS", token_transfers: [{ token_id: "0.0.2", account: "0.0.1", amount: 1000 }] }] }),
    })).rejects.toThrow("minimum");
  });
});
