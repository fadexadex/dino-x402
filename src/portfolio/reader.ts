import type {
  Portfolio,
  PortfolioAllocation,
  TokenBalance,
  MirrorAccountResponse,
  MirrorTokenInfoResponse,
} from "./types.js";

const MIRROR_BASE = "https://testnet.mirrornode.hedera.com";
const FETCH_TIMEOUT = 8_000;

const KNOWN_TOKENS: Record<string, { symbol: string; name: string }> = {
  // SaucerSwap V2 Hedera testnet defaults (Mirror metadata remains authoritative).
  "0.0.5449": { symbol: "USDC", name: "USD Coin" },
  "0.0.1183558": { symbol: "SAUCE", name: "SAUCE" },
  "0.0.15058": { symbol: "WHBAR", name: "Wrapped HBAR" },
};

const ACCOUNT_ID_RE = /^0\.0\.\d{1,10}$/;

export const isValidAccountId = (id: string): boolean => ACCOUNT_ID_RE.test(id);

const tokenInfoCache = new Map<string, { symbol: string; name: string; decimals: number }>();

export interface PortfolioReaderOptions {
  mirrorBaseUrl?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

async function fetchTokenInfo(
  tokenId: string,
  options: PortfolioReaderOptions,
): Promise<{ symbol: string; name: string; decimals: number }> {
  const cached = tokenInfoCache.get(tokenId);
  if (cached) return cached;

  const known = KNOWN_TOKENS[tokenId];

  try {
    const response = await (options.fetchFn ?? fetch)(`${options.mirrorBaseUrl ?? MIRROR_BASE}/api/v1/tokens/${tokenId}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!response.ok) throw new Error(`Token info HTTP ${response.status} for ${tokenId}`);
    const data = (await response.json()) as MirrorTokenInfoResponse;
    const decimals = Number(data.decimals);
    const entry = {
      // Prefer our curated symbols for SaucerSwap testnet ids, but never invent decimals.
      symbol: known?.symbol || data.symbol || tokenId,
      name: known?.name || data.name || "Unknown Token",
      decimals: Number.isFinite(decimals) ? decimals : known ? 6 : 0,
    };
    tokenInfoCache.set(tokenId, entry);
    return entry;
  } catch {
    // One unknown/slow token must not blank the whole wallet sidebar.
    const entry = known
      ? { ...known, decimals: 6 }
      : { symbol: tokenId, name: "Unknown Token", decimals: 0 };
    tokenInfoCache.set(tokenId, entry);
    return entry;
  }
}

export async function readPortfolio(accountId: string, options: PortfolioReaderOptions = {}): Promise<Portfolio> {
  if (!isValidAccountId(accountId)) {
    throw new Error(`Invalid Hedera account ID: ${accountId}`);
  }

  try {
    const response = await (options.fetchFn ?? fetch)(
      `${options.mirrorBaseUrl ?? MIRROR_BASE}/api/v1/accounts/${accountId}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT) },
    );
    if (response.ok) {
      const data = (await response.json()) as MirrorAccountResponse;
      const hbarBalance = BigInt(data.balance.balance);
      const hbarFormatted = Number(hbarBalance) / 1e8;

      const tokenEntries = data.balance.tokens ?? [];
      const settled = await Promise.allSettled(
        tokenEntries
          .filter((t) => t.balance > 0)
          .map(async (t) => {
            const info = await fetchTokenInfo(t.token_id, options);
            const balance = BigInt(t.balance);
            const decimals = Number.isFinite(info.decimals) ? info.decimals : 0;
            const balanceFormatted = Number(balance) / Math.pow(10, Math.max(0, decimals));
            return {
              tokenId: t.token_id,
              symbol: info.symbol,
              name: info.name,
              balance,
              decimals,
              balanceFormatted,
            } satisfies TokenBalance;
          }),
      );
      const tokens: TokenBalance[] = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

      const allocations = buildAllocations(hbarFormatted, tokens);

      return {
        accountId,
        hbarBalance,
        hbarFormatted,
        tokens,
        allocations,
        fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
        provenance: "live",
      };
    }
    throw new Error(`Mirror account HTTP ${response.status} for ${accountId}`);
  } catch (error) {
    throw new Error(`Unable to read live portfolio for ${accountId}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function buildAllocations(
  hbarFormatted: number,
  tokens: TokenBalance[],
): PortfolioAllocation[] {
  const allItems: PortfolioAllocation[] = [];

  if (hbarFormatted > 0) {
    allItems.push({
      symbol: "HBAR",
      balanceFormatted: hbarFormatted,
      // Mirror Node supplies balances, never market value. Valuation requires a
      // separately acquired live intelligence signal.
      usdValue: 0,
      allocationPct: 0,
    });
  }

  for (const token of tokens) {
    if (token.balanceFormatted > 0) {
      allItems.push({
        symbol: token.symbol,
        tokenId: token.tokenId,
        balanceFormatted: token.balanceFormatted,
        usdValue: 0,
        allocationPct: 0,
      });
    }
  }

  const total = allItems.reduce((sum, item) => sum + item.usdValue, 0);
  if (total > 0) {
    for (const item of allItems) {
      item.allocationPct = Math.round((item.usdValue / total) * 100);
    }
  }

  return allItems;
}
