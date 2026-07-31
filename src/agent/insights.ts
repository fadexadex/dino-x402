/**
 * Turns paid CoinGecko payloads into short, user-facing insight sentences.
 * These are derived from the settled x402 read — not hard-coded demo copy.
 */

export type MarketInsight = {
  symbol: string;
  price?: number;
  change24hPercent?: number;
  volume24hUsd?: number;
  source: string;
  isLive: boolean;
  sentences: string[];
};

type HistoryPoint = { t: number; price: number };

function unwrap(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const outer = data as Record<string, unknown>;
  return outer.data && typeof outer.data === "object" ? outer.data as Record<string, unknown> : outer;
}

function historyPoints(body: Record<string, unknown>): HistoryPoint[] {
  const history = body.history;
  if (!Array.isArray(history)) return [];
  return history.flatMap((point) => {
    if (!point || typeof point !== "object") return [];
    const row = point as Record<string, unknown>;
    const t = typeof row.t === "number" ? row.t : NaN;
    const price = typeof row.price === "number" ? row.price : typeof row.close === "number" ? row.close : NaN;
    if (!Number.isFinite(t) || !Number.isFinite(price) || price <= 0) return [];
    return [{ t, price }];
  });
}

function fmtUsd(value: number, digits = value >= 1 ? 2 : 5): string {
  return `$${value.toFixed(digits).replace(/\.?0+$/, (m) => m === "." ? "" : m)}`;
}

function fmtPct(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function fmtVol(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return fmtUsd(value);
}

/** Describe the strongest swing inside the paid OHLC sparkline. */
function historyNarrative(symbol: string, points: HistoryPoint[]): string | undefined {
  if (points.length < 4) return undefined;
  let peak = points[0]!;
  let trough = points[0]!;
  for (const point of points) {
    if (point.price > peak.price) peak = point;
    if (point.price < trough.price) trough = point;
  }
  const latest = points[points.length - 1]!;
  const first = points[0]!;
  const sessionMove = ((latest.price - first.price) / first.price) * 100;
  const dipFromPeak = ((latest.price - peak.price) / peak.price) * 100;
  const bounceFromTrough = ((latest.price - trough.price) / trough.price) * 100;

  if (Math.abs(sessionMove) < 0.15 && Math.abs(dipFromPeak) < 0.4) {
    return `${symbol} spent the paid window nearly flat — session move ${fmtPct(sessionMove)} on the CoinGecko sparkline.`;
  }
  if (dipFromPeak <= -1.2 && trough.t >= peak.t) {
    return `${symbol} sold off about ${fmtPct(dipFromPeak)} from its paid-session high (${fmtUsd(peak.price)} → ${fmtUsd(latest.price)}).`;
  }
  if (bounceFromTrough >= 1.2 && peak.t >= trough.t) {
    return `${symbol} bounced about ${fmtPct(bounceFromTrough)} off its paid-session low (${fmtUsd(trough.price)} → ${fmtUsd(latest.price)}).`;
  }
  return `${symbol} session range on CoinGecko: ${fmtUsd(trough.price)}–${fmtUsd(peak.price)}, last ${fmtUsd(latest.price)} (${fmtPct(sessionMove)}).`;
}

export function insightFromPaidData(symbol: string, data: unknown): MarketInsight {
  const body = unwrap(data);
  const price = typeof body.price === "number" ? body.price : typeof body.close === "number" ? body.close : undefined;
  const change24hPercent = typeof body.change24hPercent === "number" ? body.change24hPercent : undefined;
  const volume24hUsd = typeof body.volume24hUsd === "number" ? body.volume24hUsd : undefined;
  const source = typeof body.source === "string" ? body.source : "market";
  const isLive = body.isLive !== false && !String(source).includes("fallback");
  const sentences: string[] = [];

  if (price !== undefined) {
    sentences.push(
      isLive
        ? `CoinGecko marks ${symbol} at ${fmtUsd(price)} right now.`
        : `Fallback marks ${symbol} at ${fmtUsd(price)} — labeled non-live, so it cannot authorize a trade.`,
    );
  }
  if (change24hPercent !== undefined) {
    if (change24hPercent <= -3) {
      sentences.push(`${symbol} is down ${fmtPct(change24hPercent)} over 24h — that soft tape argues against adding more risk here unless a band forces it.`);
    } else if (change24hPercent >= 3) {
      sentences.push(`${symbol} is up ${fmtPct(change24hPercent)} over 24h — strength on the print, so I'm cautious about chasing unless we're repairing an underweight sleeve.`);
    } else {
      sentences.push(`${symbol}'s 24h move is ${fmtPct(change24hPercent)} — quiet enough that allocation bands matter more than momentum.`);
    }
  }
  if (volume24hUsd !== undefined && volume24hUsd > 0) {
    sentences.push(`${symbol} traded about ${fmtVol(volume24hUsd)} in 24h volume on CoinGecko.`);
  }
  const sparkline = historyNarrative(symbol, historyPoints(body));
  if (sparkline) sentences.push(sparkline);

  if (sentences.length === 0) {
    sentences.push(`Paid ${symbol} intelligence settled, but the payload had no usable price fields to narrate.`);
  }

  return { symbol, price, change24hPercent, volume24hUsd, source, isLive, sentences };
}

export function portfolioInsightNarrative(args: {
  insights: MarketInsight[];
  allocations: Array<{ symbol: string; allocationPct: number; usdValue: number }>;
  bands: Array<{ symbol: string; minPct: number; targetPct: number; maxPct: number }>;
  candidate: { action: string; fromSymbol?: string; toSymbol?: string; reason: string; amountUsd?: number };
}): string[] {
  const lines: string[] = [];
  const bySymbol = new Map(args.insights.map((insight) => [insight.symbol.toUpperCase(), insight]));
  for (const band of args.bands) {
    const sleeve = args.allocations.find((item) => item.symbol.toUpperCase() === band.symbol);
    const insight = bySymbol.get(band.symbol);
    if (!sleeve) continue;
    const pct = sleeve.allocationPct;
    if (pct > band.maxPct) {
      lines.push(
        `${band.symbol} is ${pct.toFixed(1)}% of the book (ceiling ${band.maxPct}%)${insight?.change24hPercent !== undefined ? `, with a 24h print of ${fmtPct(insight.change24hPercent)}` : ""}. That overweight is the main pressure to lighten.`,
      );
    } else if (pct < band.minPct) {
      lines.push(
        `${band.symbol} is only ${pct.toFixed(1)}% (floor ${band.minPct}%)${insight?.change24hPercent !== undefined ? `, 24h ${fmtPct(insight.change24hPercent)}` : ""}. The book is short this sleeve.`,
      );
    }
  }
  if (args.candidate.action === "swap" && args.candidate.fromSymbol && args.candidate.toSymbol) {
    const from = bySymbol.get(args.candidate.fromSymbol);
    const to = bySymbol.get(args.candidate.toSymbol);
    lines.push(
      `Based on the paid CoinGecko reads${from?.price !== undefined ? ` (${args.candidate.fromSymbol} ${fmtUsd(from.price)}` : ""}${to?.price !== undefined ? `, ${args.candidate.toSymbol} ${fmtUsd(to.price)}` : ""}${from?.price !== undefined || to?.price !== undefined ? ")" : ""}, ${args.candidate.reason}`,
    );
    if (from?.change24hPercent !== undefined && to?.change24hPercent !== undefined) {
      lines.push(
        `Market tape backing that call: ${args.candidate.fromSymbol} 24h ${fmtPct(from.change24hPercent)} vs ${args.candidate.toSymbol} 24h ${fmtPct(to.change24hPercent)}.`,
      );
    }
  } else if (lines.length === 0) {
    lines.push(`No band breach needs a swap after the paid reads — ${args.candidate.reason}`);
  } else {
    // Over/under notes already explain the book; don't contradict them with a hold line.
    lines.push(`Waiting for a paired receiver sleeve before rotating — ${args.candidate.reason}`);
  }
  return lines;
}
