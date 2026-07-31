export type Provenance = "live" | "cached" | "fallback";

export type LifecycleStep =
  | "trigger"
  | "observe"
  | "judge"
  | "acquire"
  | "reason"
  | "propose"
  | "gate"
  | "decide"
  | "execute"
  | "verify"
  | "record"
  | "noop";

export type AutonomyMode = 1 | 2 | 3 | 4;

export type Limits = {
  maxPerTrade: number;
  maxTradesPerDay: number;
  maxPortfolioMovePct: number;
  maxDailySpend: number;
  allowList: string[];
};

export type Purchase = {
  id: string;
  label: string;
  endpoint: string;
  costUsd: number;
  costLabel?: string;
  asset: "HBAR" | "USDC";
  txHash: string;
  provenance: Provenance;
  ms: number;
};

export type Proposal = {
  id: string;
  from: string;
  to: string;
  amount: number;
  expectedRate: number;
  slippagePct: number;
  resultingPosition: string;
  expiresAt: number;
  reason: string;
  withinLimits: boolean;
  breach?: string;
};

export type Settlement = {
  txHash: string;
  status: "submitted" | "confirmed";
  feeUsd: number;
  submittedAt: number;
  confirmedAt?: number;
};

export type AgentEvent = {
  id: string;
  step: LifecycleStep;
  at: number;
  title: string;
  detail?: string;
  kind?: string;
  rows?: { primary: string; secondary?: string; mono?: boolean }[];
  purchase?: Purchase;
  proposal?: Proposal;
  settlement?: Settlement;
  provenance?: Provenance;
  tone?: "ink" | "signal" | "green" | "orange";
};

export type Run = {
  id: string;
  label: string;
  startedAt: number;
  status: "running" | "awaiting" | "settled" | "no-action";
  events: AgentEvent[];
};

export type Tick = { t: number; price: number; provenance: Provenance };

export type Holding = { asset: string; amount: number; usd: number };
