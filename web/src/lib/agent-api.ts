export type Provenance = "live" | "cached" | "fallback" | "stale";

export type AssetBalance = {
  symbol: string;
  balance?: string | number;
  formatted?: string;
  usdValue?: string | number;
  allocationPct?: string | number;
  provenance?: Provenance;
};

export type PortfolioProfile = {
  id: string;
  name: string;
  kind: "user_wallet" | "agent_managed";
  accountId?: string;
  network?: string;
  autonomyMode?: 1 | 2 | 3 | 4;
  status?: "active" | "paused" | "halted" | "degraded";
  cadenceMinutes?: number;
};

export type RunEvent = {
  id: string;
  sequence?: number;
  runId?: string;
  kind: string;
  occurredAt?: string;
  title?: string;
  detail?: string;
  provenance?: Provenance;
  payload?: Record<string, unknown>;
};

export type Proposal = {
  id: string;
  status?: string;
  fromSymbol?: string;
  toSymbol?: string;
  amount?: string | number;
  expectedOutput?: string | number;
  minimumOutput?: string | number;
  slippageBps?: number;
  priceImpactBps?: number;
  expiresAt?: string;
  reason?: string;
  hashscanUrl?: string;
};

export type PortfolioSnapshot = {
  asOf?: string;
  totalUsd?: string | number;
  assets?: AssetBalance[];
  holdings?: AssetBalance[];
  provenance?: Provenance;
};

export type MandateLimits = {
  maxPerTrade?: string | number;
  maxTradesPerDay?: string | number;
  maxPortfolioMovePct?: string | number;
  maxDailySpend?: string | number;
  maxSlippageBps?: string | number;
  maxPriceImpactBps?: string | number;
  allowList?: string[];
};
export type PortfolioMandate = { objective?: string; risk?: Record<string, unknown>; limits?: MandateLimits; allocations?: Array<{ symbol: string; minPct: number; targetPct: number; maxPct: number }> };
export type DashboardRun = { id: string; status?: string; objective?: string; startedAt?: string; completedAt?: string };
export type DashboardSpend = { dataHbar?: string | number; tradeHbar?: string | number; dataTodayHbar?: string | number; tradeTodayHbar?: string | number; networkHbar?: string | number };
export type Receipt = {
  id: string;
  kind: "data_purchase" | "trade";
  runId?: string;
  occurredAt?: string;
  status?: string;
  asset?: string;
  amountHbar?: string | number;
  productId?: string;
  symbol?: string;
  transactionId?: string;
  hashscanUrl?: string;
  fromSymbol?: string;
  toSymbol?: string;
  amountIn?: string | number;
  amountOut?: string | number;
  provenance?: Provenance;
};

export type DashboardSnapshot = {
  profile?: PortfolioProfile;
  profiles?: PortfolioProfile[];
  portfolio?: PortfolioSnapshot;
  events?: RunEvent[];
  pendingProposals?: Proposal[];
  proposals?: Proposal[];
  spend?: DashboardSpend;
  system?: { halted?: boolean };
  graph?: { ticks?: Array<{ t: number; price: number; provenance: Provenance }>; markers?: Array<{ t: number; eventId: string }> };
  mandate?: PortfolioMandate | null;
  schedule?: { cadenceMinutes?: number; paused?: boolean; nextRunAt?: string; lastRunAt?: string; autonomyMode?: 1 | 2 | 3 | 4 };
  runs?: DashboardRun[];
  receipts?: Receipt[];
};

const API = "/api/v1";

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new Error(body?.error || body?.message || `Request failed (${response.status})`);
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export async function loadDashboard(): Promise<DashboardSnapshot> {
  const profiles = await request<PortfolioProfile[] | { profiles: PortfolioProfile[] }>("/profiles");
  const list = Array.isArray(profiles) ? profiles : profiles.profiles;
  if (!list.length) return { profiles: [] };
  const profile =
    list.find((item) => item.id === "connected-wallet" && item.status === "active") ??
    list.find((item) => item.kind === "agent_managed" && item.status === "active") ??
    list.find((item) => item.id === "connected-wallet") ??
    list.find((item) => item.kind === "user_wallet" && item.status === "active") ??
    list.find((item) => item.kind === "user_wallet") ??
    list[0];
  const [dashboard, graph, receiptResult] = await Promise.all([
    request<DashboardSnapshot>(`/profiles/${profile.id}/dashboard`),
    request<DashboardSnapshot["graph"]>(`/profiles/${profile.id}/graph?series=HBAR`).catch(() => undefined),
    request<{ receipts: Receipt[] }>(`/profiles/${profile.id}/receipts`).catch(() => ({ receipts: [] })),
  ]);
  return { ...dashboard, profile: { ...profile, ...dashboard.profile }, profiles: list, graph, receipts: receiptResult.receipts };
}

export const api = {
  run: (profileId: string, objective?: string, idempotencyKey = crypto.randomUUID()) => request(`/profiles/${profileId}/runs`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ objective }) }),
  approve: (proposalId: string) => request<{
    status?: string;
    message?: string;
    tradeId?: string;
    accountId?: string;
    signing?: {
      contractId: string;
      encodedParameters: string;
      amountTinybar: string;
      quote: { fromSymbol: string; toSymbol: string; fromToken: string; toToken: string };
    };
  }>(`/proposals/${proposalId}/approve`, { method: "POST" }),
  confirmProposal: (proposalId: string, transactionId: string) => request(`/proposals/${proposalId}/confirm`, { method: "POST", body: JSON.stringify({ transactionId }) }),
  reject: (proposalId: string) => request(`/proposals/${proposalId}/reject`, { method: "POST" }),
  halt: () => request("/system/halt", { method: "POST" }),
  resume: () => request("/system/resume", { method: "POST" }),
  setSchedule: (profileId: string, cadenceMinutes: number, paused: boolean, autonomyMode?: 1 | 2 | 3 | 4) => request(`/profiles/${profileId}/schedule`, { method: "PATCH", body: JSON.stringify({ cadenceMinutes, paused, ...(autonomyMode === undefined ? {} : { autonomyMode }) }) }),
  updateMandate: (profileId: string, patch: Record<string, unknown>) => request(`/profiles/${profileId}/mandate`, { method: "PATCH", body: JSON.stringify(patch) }),
  connectAccount: async (accountId: string, label?: string) => {
    const response = await fetch("/api/account/connect", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, label }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
      throw new Error(body?.error || body?.message || `Connect failed (${response.status})`);
    }
    return response.json() as Promise<{ accountId: string; profileId?: string; label?: string; connectedAt: string; needsOnboarding?: boolean }>;
  },
  getOnboarding: () => request<{
    connectedAccountId: string | null;
    userProfileId: string | null;
    agentProfileId: string | null;
    agentTreasury: { accountId: string; hbarFormatted: number; funded: boolean; signerReady: boolean } | null;
    autonomyMode: 1 | 2 | 3 | 4 | null;
  }>("/onboarding"),
  completeOnboarding: async (autonomyMode: 1 | 2 | 3 | 4, objective?: string) => {
    const response = await fetch("/api/v1/onboarding/complete", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autonomyMode, objective }),
    });
    const body = await response.json().catch(() => null) as {
      error?: string;
      agentAccountId?: string;
      funded?: boolean;
      profile?: PortfolioProfile;
      autonomyMode?: 1 | 2 | 3 | 4;
      custody?: string;
      approvalRequired?: boolean;
    } | null;
    if (!response.ok) {
      throw Object.assign(new Error(body?.error || `Onboarding failed (${response.status})`), { body, status: response.status });
    }
    return body!;
  },
};
