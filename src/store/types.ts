import type { Portfolio } from "../portfolio/types.js";
import type { BuiltSwapTransaction, SwapQuote, TradeProposal, SwapResult } from "../trading/types.js";
import type { AgentEvent, AgentRecommendation } from "../agent/types.js";

export interface ConnectedAccount {
  accountId: string;
  label?: string;
  connectedAt: string;
}

export interface ScheduleConfig {
  enabled: boolean;
  intervalMinutes: number; // e.g. 1, 5, 15, 30, 60
  autonomousTrading: boolean; // true = auto-execute, false = human-in-the-loop approval
  dataBudgetHbar: number; // Max HBAR spent on x402 data per cycle
  maxTradeHbar: number; // Max HBAR per trade
  dailyBudgetCapHbar: number; // Daily spend cap
  watchedSymbols: string[]; // e.g. ['HBAR', 'USDC', 'USDT', 'SAUCE', 'KARATE']
  nextRunAt?: string;
}

/** A custody boundary.  Legacy callers use `account` and `schedule`; profiles make
 * that state explicit without breaking the original API. */
export interface PortfolioProfile {
  id: string;
  name: string;
  kind: "user_wallet" | "agent_managed";
  accountId: string;
  network: "hedera:testnet" | string;
  status: "active" | "paused" | "halted" | "degraded";
  autonomyMode?: 1 | 2 | 3 | 4;
  cadenceMinutes?: number;
  mandateId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioMandate {
  id: string;
  profileId: string;
  version: number;
  objective?: string;
  allocations: Array<{ symbol: "HBAR" | "USDC" | "SAUCE"; tokenId?: string; minPct: number; targetPct: number; maxPct: number }>;
  risk: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface DurableEvent {
  id: string;
  sequence: number;
  type: string;
  occurredAt: string;
  profileId?: string;
  runId?: string;
  provenance?: "live" | "cached" | "fallback" | "stale";
  payload: unknown;
}

export interface SchedulerLease {
  key: string;
  holderId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface PendingTrade {
  id: string;
  runId: string;
  accountId: string;
  proposal: TradeProposal;
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "expired";
  executionResult?: SwapResult;
  quote?: SwapQuote;
  builtTransaction?: BuiltSwapTransaction;
  evaluatedAt?: string;
  rejectionReason?: string;
}

export interface AgentMultiRunRecord {
  id: string;
  accountId: string;
  /** Custody profile that started the run — used so shared account IDs do not mix rails. */
  profileId?: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "waiting_approval";
  objective: string;
  idempotencyKey?: string;
  portfolioBefore?: Portfolio;
  portfolioAfter?: Portfolio;
  dataPurchases: Array<{
    symbol: string;
    productId: string;
    amountHbar: number;
    transactionId: string;
    hashscanUrl: string;
    data: unknown;
  }>;
  spentDataHbar: number;
  recommendation?: AgentRecommendation;
  tradeProposals: TradeProposal[];
  tradeExecutions: SwapResult[];
  pendingTradeIds: string[];
  events: AgentEvent[];
  error?: string;
}

export interface SpendingLedger {
  todayDataHbar: number;
  todayTradeHbar: number;
  totalDataHbar: number;
  totalTradeHbar: number;
  lastResetDate: string; // YYYY-MM-DD
}

export interface StoreState {
  account: ConnectedAccount | null;
  /** Explicitly selected custody session; falls back to any `status: "active"` profile. */
  activeProfileId?: string | null;
  schedule: ScheduleConfig;
  runs: AgentMultiRunRecord[];
  pendingTrades: PendingTrade[];
  spending: SpendingLedger;
  logs: Array<{ id: string; level: "info" | "warn" | "error"; message: string; timestamp: string }>;
  /** Durable v2 domain state.  All fields are optional additions for compatibility. */
  profiles?: PortfolioProfile[];
  mandates?: PortfolioMandate[];
  events?: DurableEvent[];
  schedulerLeases?: SchedulerLease[];
  system?: { halted: boolean; haltedAt?: string; reason?: string };
}
