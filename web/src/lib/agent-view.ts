import type { AgentEvent, Holding, LifecycleStep, Proposal, Purchase, Settlement, Tick } from "./agent-types";
import type { AssetBalance, PortfolioSnapshot, Receipt, RunEvent } from "./agent-api";

const number = (value: unknown) => typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[^0-9.-]/g, "")) || 0 : 0;
const at = (value?: string) => value ? new Date(value).getTime() : Date.now();

export function toHoldings(portfolio?: PortfolioSnapshot): Holding[] {
  return (portfolio?.assets ?? portfolio?.holdings ?? []).map((asset: AssetBalance) => ({
    asset: asset.symbol,
    amount: number(asset.balance ?? asset.formatted),
    usd: number(asset.usdValue),
  }));
}

const USER_FACING_KIND =
  /^(portfolio\.|payment\.|data\.|analysis\.|agent\.thinking|user\.message|trade\.|run\.(completed|failed|no_action|triggered)|system\.(halted|resumed))/;

export function isUserFacingKind(kind: string): boolean {
  return USER_FACING_KIND.test(kind);
}

/** Thoughts + user chat are rendered by dedicated components, not EventCards. */
export function isStreamMetaKind(kind: string): boolean {
  return kind === "agent.thinking" || kind === "user.message";
}

function lifecycle(kind: string): LifecycleStep {
  if (kind === "user.message") return "trigger";
  if (kind.startsWith("agent.")) return "reason";
  if (kind.startsWith("portfolio.")) return "observe";
  if (kind === "payment.required" || kind === "payment.settled" || kind.startsWith("data.")) return "acquire";
  if (kind.startsWith("analysis.")) return "reason";
  if (kind === "trade.proposed") return "propose";
  if (kind === "trade.awaiting_approval") return "gate";
  if (kind === "trade.approved" || kind === "trade.rejected") return "decide";
  if (kind === "trade.submitted" || kind === "trade.executed") return "execute";
  if (kind === "trade.verified") return "verify";
  if (kind.includes("completed") || kind.includes("recorded")) return "record";
  if (kind.includes("skipped") || kind.includes("no_action")) return "noop";
  if (kind.includes("created") || kind.includes("triggered")) return "trigger";
  return "record";
}

export function toEvent(event: RunEvent, receipts: Receipt[] = []): AgentEvent {
  const payload = event.payload ?? {};
  const payloadResult = payload.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : undefined;
  const transactionId = String(payload.transactionId ?? payloadResult?.transactionId ?? "");
  const receipt = receipts.find((item) => transactionId ? item.transactionId === transactionId : item.runId === event.runId && ((event.kind === "payment.settled" && item.kind === "data_purchase") || (event.kind === "trade.verified" && item.kind === "trade")));
  const purchase: Purchase | undefined = event.kind === "payment.settled" && (receipt?.kind === "data_purchase" || transactionId) ? {
    id: receipt?.id ?? event.id,
    label: [receipt?.symbol, receipt?.productId].filter(Boolean).join(" · ") || event.title || event.kind,
    endpoint: receipt?.productId ? `GET /data/${receipt.productId}` : "Paid x402 resource",
    costUsd: number(receipt?.amountHbar),
    costLabel: receipt?.amountHbar !== undefined
      ? `${number(receipt.amountHbar).toFixed(8).replace(/\.?0+$/, "")} HBAR`
      : undefined,
    asset: "HBAR",
    txHash: receipt?.transactionId ?? transactionId,
    provenance: (receipt?.provenance === "stale" ? "fallback" : receipt?.provenance) ?? (event.provenance === "stale" ? "fallback" : event.provenance) ?? "live",
    ms: 0,
  } : undefined;
  const proposal = event.kind === "trade.proposed" && payload.proposal && typeof payload.proposal === "object"
    ? toProposal({
        id: String((payload.proposal as Record<string, unknown>).id ?? event.id),
        fromSymbol: String((payload.proposal as TradeLike).fromSymbol ?? ""),
        toSymbol: String((payload.proposal as TradeLike).toSymbol ?? ""),
        amount: (payload.proposal as TradeLike).amountFormatted,
        reason: String((payload.proposal as TradeLike).reasoning ?? event.detail ?? ""),
      })
    : undefined;
  const settlement: Settlement | undefined =
    event.kind === "trade.submitted"
      ? {
          txHash: transactionId || "pending",
          status: "submitted",
          feeUsd: 0,
          submittedAt: at(event.occurredAt),
        }
      : event.kind === "trade.verified"
        ? {
            txHash: receipt?.transactionId ?? transactionId,
            status: "confirmed",
            feeUsd: 0,
            submittedAt: at(receipt?.occurredAt ?? event.occurredAt),
            confirmedAt: at(event.occurredAt),
          }
        : undefined;
  return {
    id: event.id,
    step: lifecycle(event.kind),
    at: at(event.occurredAt),
    title: event.title ?? event.kind.replace(/[._]/g, " "),
    detail: event.detail,
    provenance: event.provenance === "stale" ? "fallback" : event.provenance,
    tone:
      event.kind === "user.message"
        ? "ink"
        : event.kind.includes("failed") || event.kind.includes("blocked") || event.kind.includes("skipped")
          ? "orange"
          : event.kind.includes("settled") || event.kind.includes("verified")
            ? "green"
            : event.kind.includes("payment") || event.kind === "agent.thinking"
              ? "signal"
              : "ink",
    purchase,
    proposal,
    settlement,
    price: number(payload.price ?? payload.usdPrice),
    kind: event.kind,
  } as AgentEvent & { price: number; kind: string };
}

type TradeLike = {
  fromSymbol?: string;
  toSymbol?: string;
  amountFormatted?: string | number;
  reasoning?: string;
  id?: string;
};

export function toProposal(value: { id: string; fromSymbol?: string; toSymbol?: string; amount?: string | number; expectedOutput?: string | number; minimumOutput?: string | number; slippageBps?: number; expiresAt?: string; reason?: string }): Proposal {
  return { id: value.id, from: value.fromSymbol ?? "—", to: value.toSymbol ?? "—", amount: number(value.amount), expectedRate: 0, slippagePct: (value.slippageBps ?? 0) / 100, resultingPosition: value.minimumOutput ? `Minimum receive ${value.minimumOutput}` : "Pending verification", expiresAt: at(value.expiresAt), reason: value.reason ?? "Trade proposal awaiting review.", withinLimits: true };
}

export function toTicks(events: AgentEvent[]): Tick[] {
  return events.flatMap((event) => {
    const value = number((event as AgentEvent & { price?: unknown }).price);
    return value > 0 ? [{ t: event.at, price: value, provenance: event.provenance ?? "live" }] : [];
  });
}
