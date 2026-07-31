import { describe, expect, it } from "vitest";
import { insightFromPaidData, portfolioInsightNarrative } from "../src/agent/insights.js";

describe("CoinGecko insight narration", () => {
  it("surfaces price, 24h change, volume, and sparkline moves from a paid quote", () => {
    const insight = insightFromPaidData("HBAR", {
      product: "quote",
      data: {
        price: 0.068,
        change24hPercent: -2.4,
        volume24hUsd: 12_500_000,
        source: "CoinGecko",
        isLive: true,
        history: [
          { t: 1, price: 0.07 },
          { t: 2, price: 0.069 },
          { t: 3, price: 0.067 },
          { t: 4, price: 0.068 },
        ],
      },
    });
    expect(insight.sentences.join(" ")).toMatch(/CoinGecko marks HBAR/);
    expect(insight.sentences.join(" ")).toMatch(/24h/);
    expect(insight.sentences.join(" ")).toMatch(/volume|traded/i);
    expect(insight.sentences.length).toBeGreaterThanOrEqual(3);
  });

  it("builds a portfolio narrative that cites overweight and underweight sleeves", () => {
    const lines = portfolioInsightNarrative({
      insights: [
        { symbol: "HBAR", price: 0.07, change24hPercent: -1.2, source: "CoinGecko", isLive: true, sentences: [] },
        { symbol: "SAUCE", price: 0.01, change24hPercent: 2.5, source: "CoinGecko", isLive: true, sentences: [] },
      ],
      allocations: [
        { symbol: "HBAR", allocationPct: 55, usdValue: 40 },
        { symbol: "USDC", allocationPct: 35, usdValue: 25 },
        { symbol: "SAUCE", allocationPct: 10, usdValue: 7 },
      ],
      bands: [
        { symbol: "HBAR", minPct: 25, targetPct: 34, maxPct: 45 },
        { symbol: "USDC", minPct: 25, targetPct: 33, maxPct: 45 },
        { symbol: "SAUCE", minPct: 10, targetPct: 33, maxPct: 40 },
      ],
      candidate: {
        action: "swap",
        fromSymbol: "HBAR",
        toSymbol: "SAUCE",
        reason: "HBAR exceeds its 45% ceiling while SAUCE is below its 10% floor.",
        amountUsd: 5,
      },
    });
    expect(lines.some((line) => /HBAR is 55/.test(line))).toBe(true);
    expect(lines.some((line) => /Based on the paid CoinGecko reads/.test(line))).toBe(true);
    expect(lines.some((line) => /Market tape backing/.test(line))).toBe(true);
  });
});
