import type { DataProvider, DataProduct, DataResult } from "../../core/provider.js";
import { generateData, MOCK_WINDOW_SEC } from "../mock/generator.js";

const CATALOG: DataProduct[] = [
  {
    id: "spot-price",
    description: "Live USD spot price for a supported digital asset",
    asset: "0.0.0",
    priceAtomic: "1000000",
    paramsSchema: { symbol: { type: "string", required: true } },
    freshnessWindowSec: 30,
  },
  {
    id: "quote",
    description: "Live USD price, 24 hour change, and market volume",
    asset: "0.0.0",
    priceAtomic: "2000000",
    paramsSchema: { symbol: { type: "string", required: true } },
    freshnessWindowSec: 30,
  },
  {
    id: "ohlc",
    description: "Latest live USD OHLC candle for a digital asset",
    asset: "0.0.0",
    priceAtomic: "5000000",
    paramsSchema: {
      symbol: { type: "string", required: true },
      date: { type: "string", required: true },
    },
    freshnessWindowSec: 300,
  },
];

const COIN_IDS: Record<string, string> = {
  HBAR: "hedera-hashgraph",
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  USDC: "usd-coin",
  SAUCE: "saucerswap",
};

const responseCache = new Map<string, { expiresAt: number; value: unknown }>();

const fetchJson = async <T>(url: string, cacheTtlMs: number): Promise<T> => {
  const cached = responseCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json", "user-agent": "MarketRail-x402-demo/1.0" },
      });
      if (response.ok) {
        const value = await response.json() as T;
        responseCache.set(url, { expiresAt: Date.now() + cacheTtlMs, value });
        return value;
      }
      lastError = new Error(`CoinGecko returned ${response.status}`);
      if (response.status !== 429 && response.status < 500) break;
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
      const delayMs = Number.isFinite(retryAfter)
        ? Math.min(retryAfter * 1_000, 1_500)
        : 250 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("CoinGecko request failed");
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error("CoinGecko request failed");
};

const fallback = (productId: string, symbol: string, date?: string): DataResult => {
  const generated = generateData({
    productId,
    symbol,
    date,
    windowSeed: Math.floor(Date.now() / 1000 / MOCK_WINDOW_SEC),
  }) as Record<string, unknown>;
  // Keep a usable mid price on quote fallbacks so the agent can still value sleeves
  // (labeled non-live — trade policy will refuse to authorize on this provenance).
  if (productId === "quote") {
    const bid = typeof generated.bid === "number" ? generated.bid : undefined;
    const ask = typeof generated.ask === "number" ? generated.ask : undefined;
    const mid = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : bid ?? ask;
    return {
      data: {
        ...generated,
        ...(mid !== undefined ? { price: mid } : {}),
        change24hPercent: 0,
        volume24hUsd: 0,
        currency: "USD",
        source: "deterministic-fallback",
        isLive: false,
      },
      asOf: new Date().toISOString(),
      providerId: "market:fallback",
    };
  }
  return {
    data: {
      ...generated,
      currency: "USD",
      source: "deterministic-fallback",
      isLive: false,
    },
    asOf: new Date().toISOString(),
    providerId: "market:fallback",
  };
};

export class MarketDataProvider implements DataProvider {
  readonly id = "market";

  catalog(): DataProduct[] {
    return CATALOG;
  }

  async fetch(productId: string, params: Record<string, string>): Promise<DataResult> {
    if (!CATALOG.some((product) => product.id === productId)) {
      throw new Error(`Unknown product: ${productId}`);
    }

    const symbol = (params.symbol ?? "").toUpperCase();
    const coinId = COIN_IDS[symbol];
    if (!coinId) {
      throw new Error(`Unsupported symbol: ${symbol}. Try HBAR, USDC, or SAUCE.`);
    }

    try {
      if (productId === "ohlc") {
        const candles = await fetchJson<[number, number, number, number, number][]>(
          `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=1`,
          5 * 60_000,
        );
        const candle = candles.at(-1);
        if (!candle) throw new Error("CoinGecko returned no candles");
        const [timestamp, open, high, low, close] = candle;
        return {
          data: {
            date: params.date,
            open,
            high,
            low,
            close,
            candleAt: new Date(timestamp).toISOString(),
            currency: "USD",
            source: "CoinGecko",
            isLive: true,
          },
          asOf: new Date().toISOString(),
          providerId: this.id,
        };
      }

      const payload = await fetchJson<Record<
        string,
        { usd?: number; usd_24h_change?: number; usd_24h_vol?: number; last_updated_at?: number }
      >>(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_last_updated_at=true`,
        30_000,
      );
      const quote = payload[coinId];
      if (!quote || typeof quote.usd !== "number") throw new Error("CoinGecko returned no price");

      // Attach a short CoinGecko OHLC sparkline so the workspace graph has a real
      // series from the same paid read — not just a single spot sample.
      let history: Array<{ t: number; price: number }> = [];
      try {
        const candles = await fetchJson<[number, number, number, number, number][]>(
          `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=1`,
          5 * 60_000,
        );
        history = candles
          .filter((candle) => Array.isArray(candle) && typeof candle[0] === "number" && typeof candle[4] === "number")
          .map(([timestamp, , , , close]) => ({ t: timestamp, price: close }));
      } catch {
        history = [];
      }

      const common = {
        currency: "USD",
        source: "CoinGecko",
        isLive: true,
        lastUpdatedAt: quote.last_updated_at
          ? new Date(quote.last_updated_at * 1000).toISOString()
          : undefined,
        ...(history.length > 0 ? { history } : {}),
      };
      const data = productId === "spot-price"
        ? { price: quote.usd, ...common }
        : {
            price: quote.usd,
            change24hPercent: quote.usd_24h_change,
            volume24hUsd: quote.usd_24h_vol,
            ...common,
          };

      return { data, asOf: new Date().toISOString(), providerId: this.id };
    } catch (error) {
      console.warn(
        `[market-provider] live feed unavailable; using labeled fallback: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return fallback(productId, symbol, params.date);
    }
  }
}

/**
 * Free CoinGecko batch quote for workspace display (connect / dashboard).
 * Not a paid x402 read — trade authorization still requires paid provenance.
 */
export async function fetchDisplayUsdPrices(
  symbols: readonly string[],
): Promise<{ prices: Record<string, number>; provenance: "live" | "fallback" }> {
  const wanted = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))];
  const prices: Record<string, number> = {};
  if (wanted.includes("USDC")) prices.USDC = 1;

  const coinIds = wanted
    .map((symbol) => ({ symbol, coinId: COIN_IDS[symbol] }))
    .filter((row): row is { symbol: string; coinId: string } => Boolean(row.coinId));

  if (coinIds.length === 0) {
    return { prices, provenance: "fallback" };
  }

  try {
    const ids = [...new Set(coinIds.map((row) => row.coinId))].join(",");
    const payload = await fetchJson<Record<string, { usd?: number }>>(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`,
      30_000,
    );
    for (const { symbol, coinId } of coinIds) {
      const usd = payload[coinId]?.usd;
      if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) {
        prices[symbol] = usd;
      }
    }
    if (prices.USDC === undefined) prices.USDC = 1;
    return { prices, provenance: "live" };
  } catch (error) {
    console.warn(
      `[display-prices] CoinGecko unavailable; using stablecoin + labeled fallbacks:`,
      error instanceof Error ? error.message : error,
    );
    // Deterministic labeled mid prices so the sidebar still marks the book on connect.
    const provider = new MarketDataProvider();
    for (const symbol of wanted) {
      if (prices[symbol] !== undefined) continue;
      if (!COIN_IDS[symbol]) continue;
      try {
        const result = await provider.fetch("spot-price", { symbol });
        const body = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
        const price = typeof body.price === "number" ? body.price : undefined;
        if (typeof price === "number" && price > 0) prices[symbol] = price;
      } catch {
        /* leave unpriced */
      }
    }
    if (prices.USDC === undefined) prices.USDC = 1;
    return { prices, provenance: "fallback" };
  }
}
