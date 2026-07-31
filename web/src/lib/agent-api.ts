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
  activeProfileId?: string | null;
  portfolio?: PortfolioSnapshot;
  events?: RunEvent[];
  pendingProposals?: Proposal[];
  proposals?: Proposal[];
  spend?: DashboardSpend;
  system?: { halted?: boolean };
  graph?: {
    ticks?: Array<{ t: number; price: number; provenance: Provenance }>;
    markers?: Array<{ t: number; eventId: string }>;
    weights?: Array<{ t: number; weight: number }>;
  };
  mandate?: PortfolioMandate | null;
  schedule?: { cadenceMinutes?: number; paused?: boolean; nextRunAt?: string; lastRunAt?: string; autonomyMode?: 1 | 2 | 3 | 4 };
  runs?: DashboardRun[];
  receipts?: Receipt[];
};

const API = "/api/v1";
const ACTIVE_PROFILE_KEY = "dino.activeProfileId";

export function getPreferredProfileId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(ACTIVE_PROFILE_KEY);
}

export function setPreferredProfileId(profileId: string | null): void {
  if (typeof localStorage === "undefined") return;
  if (profileId) localStorage.setItem(ACTIVE_PROFILE_KEY, profileId);
  else localStorage.removeItem(ACTIVE_PROFILE_KEY);
}

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

function pickProfile(list: PortfolioProfile[], preferredId?: string | null, serverActiveId?: string | null): PortfolioProfile | undefined {
  const visible = list.filter((item) => item.id !== "connected-wallet");
  const pool = visible.length ? visible : list;
  return (
    (preferredId ? pool.find((item) => item.id === preferredId) : undefined) ??
    (serverActiveId ? pool.find((item) => item.id === serverActiveId) : undefined) ??
    pool.find((item) => item.status === "active") ??
    pool.find((item) => item.kind === "agent_managed" && item.status === "active") ??
    pool.find((item) => item.kind === "user_wallet" && item.status === "active") ??
    pool.find((item) => item.kind === "user_wallet") ??
    pool.find((item) => item.kind === "agent_managed") ??
    pool[0]
  );
}

export async function loadDashboard(preferredProfileId?: string | null): Promise<DashboardSnapshot> {
  const profilesResponse = await request<PortfolioProfile[] | { profiles: PortfolioProfile[]; activeProfileId?: string | null }>("/profiles");
  const list = Array.isArray(profilesResponse) ? profilesResponse : profilesResponse.profiles;
  const serverActiveId = Array.isArray(profilesResponse) ? null : profilesResponse.activeProfileId ?? null;
  if (!list.length) return { profiles: [], activeProfileId: null };
  const preferred = preferredProfileId ?? getPreferredProfileId();
  const profile = pickProfile(list, preferred, serverActiveId);
  if (!profile) return { profiles: list, activeProfileId: serverActiveId };
  setPreferredProfileId(profile.id);
  const [dashboard, graph, receiptResult] = await Promise.all([
    request<DashboardSnapshot>(`/profiles/${profile.id}/dashboard`),
    request<DashboardSnapshot["graph"]>(`/profiles/${profile.id}/graph?series=HBAR`).catch(() => undefined),
    request<{ receipts: Receipt[] }>(`/profiles/${profile.id}/receipts`).catch(() => ({ receipts: [] })),
  ]);
  return {
    ...dashboard,
    profile: { ...profile, ...dashboard.profile },
    profiles: list,
    activeProfileId: profile.id,
    graph,
    receipts: receiptResult.receipts,
  };
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
      quote: { fromSymbol: string; toSymbol: string; fromToken: string; toToken: string; amountIn?: string };
    };
  }>(`/proposals/${proposalId}/approve`, { method: "POST" }),
  confirmProposal: (proposalId: string, transactionId: string) => request(`/proposals/${proposalId}/confirm`, { method: "POST", body: JSON.stringify({ transactionId }) }),
  reject: (proposalId: string) => request(`/proposals/${proposalId}/reject`, { method: "POST" }),
  halt: () => request("/system/halt", { method: "POST" }),
  resume: () => request("/system/resume", { method: "POST" }),
  setSchedule: (profileId: string, cadenceMinutes: number, paused: boolean, autonomyMode?: 1 | 2 | 3 | 4) => request(`/profiles/${profileId}/schedule`, { method: "PATCH", body: JSON.stringify({ cadenceMinutes, paused, ...(autonomyMode === undefined ? {} : { autonomyMode }) }) }),
  updateMandate: (profileId: string, patch: Record<string, unknown>) => request(`/profiles/${profileId}/mandate`, { method: "PATCH", body: JSON.stringify(patch) }),
  activateProfile: async (profileId: string) => {
    const result = await request<{ profile: PortfolioProfile; activeProfileId: string }>(`/profiles/${profileId}/activate`, { method: "POST" });
    setPreferredProfileId(result.activeProfileId);
    return result;
  },
  disconnectAccount: async () => {
    const response = await fetch("/api/account/disconnect", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
      throw new Error(body?.error || body?.message || `Disconnect failed (${response.status})`);
    }
    setPreferredProfileId(null);
    return response.json() as Promise<{ disconnected: boolean; accountId: string | null }>;
  },
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
    const result = await response.json() as { accountId: string; profileId?: string; label?: string; connectedAt: string; needsOnboarding?: boolean };
    if (result.profileId) setPreferredProfileId(result.profileId);
    return result;
  },
  getOnboarding: () => request<{
    connectedAccountId: string | null;
    userProfileId: string | null;
    agentProfileId: string | null;
    activeProfileId?: string | null;
    sessions?: Array<{
      id: string;
      name: string;
      kind: "user_wallet" | "agent_managed";
      accountId: string;
      status: string;
      autonomyMode: 1 | 2 | 3 | 4 | null;
    }>;
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
    if (body?.profile?.id) setPreferredProfileId(body.profile.id);
    return body!;
  },
};
