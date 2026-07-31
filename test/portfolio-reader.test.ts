import { describe, expect, it } from "vitest";
import { readPortfolio } from "../src/portfolio/reader.js";

describe("readPortfolio resilience", () => {
  it("still returns HBAR when a token metadata lookup fails", async () => {
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/accounts/")) {
        return new Response(JSON.stringify({
          balance: {
            balance: 1_500_000_000,
            tokens: [
              { token_id: "0.0.5449", balance: 1_000_000 },
              { token_id: "0.0.999999", balance: 50 },
            ],
          },
        }), { status: 200 });
      }
      if (url.includes("/api/v1/tokens/0.0.5449")) {
        return new Response(JSON.stringify({ symbol: "USDC", name: "USD Coin", decimals: "6", type: "FUNGIBLE", total_supply: "0" }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    const portfolio = await readPortfolio("0.0.1234", { fetchFn });
    expect(portfolio.hbarFormatted).toBeCloseTo(15);
    expect(portfolio.allocations.some((item) => item.symbol === "HBAR")).toBe(true);
    expect(portfolio.allocations.some((item) => item.symbol === "USDC")).toBe(true);
    // Failed metadata falls back to the token id rather than blanking the book.
    expect(portfolio.allocations.some((item) => item.symbol === "0.0.999999")).toBe(true);
  });
});
