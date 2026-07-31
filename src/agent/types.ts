import type { DataProduct } from "../core/provider.js";
import type { TradeProposal } from "../trading/types.js";
import type { Portfolio } from "../portfolio/types.js";

export type AgentEventKind =
  | "catalog.discovered"
  | "plan.created"
  | "payment.required"
  | "payment.authorized"
  | "payment.response"
  | "payment.settled"
  | "data.received"
  | "analysis.completed"
  | "agent.thinking"
  | "user.message"
  | "run.triggered"
  | "run.completed"
  | "run.failed"
  | "portfolio.read"
  | "trade.proposed"
  | "trade.approved"
  | "trade.submitted"
  | "trade.executed"
  | "trade.verified"
  | "trade.skipped";

export interface AgentEvent {
  seq: number;
  kind: AgentEventKind;
  at: string;
  title: string;
  detail: string;
  metadata?: Record<string, unknown>;
}

export interface PortfolioHolding {
  symbol: string;
  units?: number;
  allocationPct?: number;
}

export interface AgentRunInput {
  objective?: string;
  symbol?: string;
  budgetAtomic?: string | number;
  portfolio?: PortfolioHolding[];
}

export interface PurchasePlan {
  productId: string;
  params: Record<string, string>;
  reason: string;
  source: "mistral" | "deterministic";
  fallbackReason?: string;
}

export interface AgentRecommendation {
  summary: string;
  action: "hold" | "watch" | "rebalance";
  confidence: number;
  rationale: string[];
  source: "mistral" | "deterministic";
  fallbackReason?: string;
}

export interface AgentRunResult {
  id: string;
  status: "completed" | "failed";
  objective: string;
  budgetAtomic: string;
  spentAtomic: string;
  plan?: PurchasePlan;
  purchase?: {
    productId: string;
    params: Record<string, string>;
    amountAtomic: string;
    asset: string;
    transactionId: string;
    hashscanUrl: string;
    data: unknown;
  };
  recommendation?: AgentRecommendation;
  events: AgentEvent[];
  error?: string;
}

export interface CatalogResponse {
  providerId: string;
  products: DataProduct[];
}
