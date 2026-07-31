import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner, PrivateKey as HederaPrivateKey } from "@x402/hedera";
import type { Network } from "@x402/core/types";
import type { ServerConfig } from "../core/config.js";
import type { DataProduct } from "../core/provider.js";
import { MistralAdvisor } from "./mistral.js";
import type {
  AgentEvent,
  AgentRunInput,
  AgentRunResult,
  CatalogResponse,
  PortfolioHolding,
} from "./types.js";

const DEFAULT_OBJECTIVE = "Protect the demo portfolio by buying only the market signal needed for a cautious allocation decision.";
const DEFAULT_PORTFOLIO: PortfolioHolding[] = [
  { symbol: "HBAR", units: 5000, allocationPct: 35 },
  { symbol: "BTC", units: 0.05, allocationPct: 40 },
  { symbol: "USD", units: 2500, allocationPct: 25 },
];

const normalizeSymbol = (value: unknown): string => {
  const symbol = typeof value === "string" ? value.trim().toUpperCase() : "HBAR";
  if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) throw new Error("Symbol must be 1-12 letters, numbers, dots, or dashes");
  return symbol;
};

const safePortfolio = (value: unknown): PortfolioHolding[] => {
  if (!Array.isArray(value)) return DEFAULT_PORTFOLIO;
  return value.slice(0, 12).map((holding) => {
    if (!holding || typeof holding !== "object") throw new Error("Invalid portfolio holding");
    const item = holding as Record<string, unknown>;
    const normalized: PortfolioHolding = { symbol: normalizeSymbol(item.symbol) };
    if (typeof item.units === "number" && Number.isFinite(item.units)) normalized.units = item.units;
    if (typeof item.allocationPct === "number" && item.allocationPct >= 0 && item.allocationPct <= 100) {
      normalized.allocationPct = item.allocationPct;
    }
    return normalized;
  });
};

const decodeRequired = (header: string | null): Record<string, unknown> => {
  if (!header) return {};
  try {
    const body = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
    const accepts = Array.isArray(body.accepts) ? body.accepts[0] as Record<string, unknown> | undefined : undefined;
    if (!accepts) return {};
    return {
      scheme: accepts.scheme,
      network: accepts.network,
      amount: accepts.amount,
      asset: accepts.asset,
      payTo: accepts.payTo,
      maxTimeoutSeconds: accepts.maxTimeoutSeconds,
    };
  } catch {
    return { challenge: "received" };
  }
};

export const hashscanTransactionUrl = (transactionId: string): string => {
  const match = transactionId.match(/^(.+?)@(\d+)\.(\d+)$/);
  const pathId = match ? `${match[1]}-${match[2]}-${match[3]}` : transactionId;
  return `https://hashscan.io/testnet/transaction/${encodeURIComponent(pathId)}`;
};

export class AgentRunner {
  private readonly advisor: MistralAdvisor;
  private readonly maxSpendAtomic: bigint;

  constructor(private readonly config: ServerConfig) {
    this.advisor = new MistralAdvisor({
      apiKey: config.mistralApiKey,
      model: config.mistralModel ?? "mistral-small-latest",
    });
    this.maxSpendAtomic = BigInt(config.agentMaxSpendAtomic ?? "5000000");
  }

  isPaymentReady(): boolean {
    return Boolean(this.config.agentPayerId && this.config.agentPayerKey);
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const events: AgentEvent[] = [];
    const event = (kind: AgentEvent["kind"], title: string, detail: string, metadata?: Record<string, unknown>) => {
      events.push({ seq: events.length + 1, kind, at: new Date().toISOString(), title, detail, metadata });
    };
    const id = crypto.randomUUID();
    const objective = typeof input.objective === "string" && input.objective.trim()
      ? input.objective.trim().slice(0, 600)
      : DEFAULT_OBJECTIVE;
    let budgetAtomic = this.maxSpendAtomic;
    try {
      if (input.budgetAtomic !== undefined) {
        const requested = BigInt(input.budgetAtomic);
        if (requested <= 0n) throw new Error("Budget must be positive");
        budgetAtomic = requested < this.maxSpendAtomic ? requested : this.maxSpendAtomic;
      }
      const symbol = normalizeSymbol(input.symbol);
      const portfolio = safePortfolio(input.portfolio);
      const baseUrl = (this.config.agentDataBaseUrl ?? `http://127.0.0.1:${this.config.port}`).replace(/\/$/, "");

      const catalogResponse = await fetch(`${baseUrl}/catalog`, { signal: AbortSignal.timeout(8_000) });
      if (!catalogResponse.ok) throw new Error(`Catalog discovery failed with HTTP ${catalogResponse.status}`);
      const catalog = await catalogResponse.json() as CatalogResponse;
      if (!Array.isArray(catalog.products) || catalog.products.length === 0) throw new Error("The catalog is empty");
      event("catalog.discovered", "Marketplace discovered", `Found ${catalog.products.length} pay-per-query products.`, {
        providerId: catalog.providerId,
        products: catalog.products.map((product) => ({ id: product.id, priceAtomic: product.priceAtomic, asset: product.asset })),
      });

      const plan = await this.advisor.choosePurchase({
        objective,
        requestedSymbol: symbol,
        portfolio,
        products: catalog.products,
        budgetAtomic: budgetAtomic.toString(),
      });
      const product = catalog.products.find((item) => item.id === plan.productId) as DataProduct | undefined;
      if (!product) throw new Error("Purchase plan selected an unknown product");
      const price = BigInt(product.priceAtomic);
      if (price > budgetAtomic || price > this.maxSpendAtomic) throw new Error("Purchase blocked by spend policy");
      event("plan.created", "Purchase plan approved", plan.reason, {
        source: plan.source,
        fallbackReason: plan.fallbackReason,
        productId: plan.productId,
        params: plan.params,
        priceAtomic: product.priceAtomic,
        budgetAtomic: budgetAtomic.toString(),
      });

      if (!this.config.agentPayerId || !this.config.agentPayerKey) {
        throw new Error("Agent payment credentials are not configured");
      }
      const signer = createClientHederaSigner(
        this.config.agentPayerId,
        HederaPrivateKey.fromStringECDSA(this.config.agentPayerKey),
        { network: this.config.hederaNetwork as Network },
      );
      const client = new x402Client()
        .register("hedera:*", new ExactHederaScheme(signer))
        .registerPolicy((_version, requirements) => requirements.filter((requirement) => (
          requirement.scheme === "exact" &&
          requirement.network === this.config.hederaNetwork &&
          requirement.asset === product.asset &&
          requirement.payTo === this.config.payToAccount &&
          requirement.amount === product.priceAtomic &&
          /^\d+$/.test(requirement.amount) &&
          BigInt(requirement.amount) <= budgetAtomic &&
          BigInt(requirement.amount) <= this.maxSpendAtomic
        )));
      const httpClient = new x402HTTPClient(client);
      let challengeSeen = false;
      let authorizationRecorded = false;

      const tracedFetch: typeof fetch = async (request, init) => {
        const headers = new Headers(request instanceof Request ? request.headers : undefined);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        // @x402/fetch retries with a cloned Request after it signs the v2 payload.
        // Some fetch implementations do not preserve cross-realm Request identity,
        // so the observed 402 -> retry boundary is the reliable instrumentation seam.
        if (challengeSeen && !authorizationRecorded) {
          event("payment.authorized", "Payment authorized", "A short-lived payment payload was signed inside the server key boundary.", {
            payer: this.config.agentPayerId,
          });
          authorizationRecorded = true;
        }
        const response = await fetch(request, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
        if (response.status === 402) {
          challengeSeen = true;
          event("payment.required", "HTTP 402 received", "The data server quoted an x402 payment requirement.", decodeRequired(response.headers.get("payment-required")));
        } else {
          event("payment.response", `HTTP ${response.status} received`, "The signed request was returned by the paid endpoint.", { status: response.status });
        }
        return response;
      };
      const fetchWithPayment = wrapFetchWithPayment(tracedFetch, client);
      const query = new URLSearchParams(plan.params);
      const paidResponse = await fetchWithPayment(`${baseUrl}/data/${encodeURIComponent(plan.productId)}?${query}`);
      const responseText = await paidResponse.text();
      let body: unknown;
      try { body = JSON.parse(responseText); } catch { body = { raw: responseText.slice(0, 500) }; }
      if (!paidResponse.ok) throw new Error(`Paid endpoint returned HTTP ${paidResponse.status}`);

      const settlement = httpClient.getPaymentSettleResponse((name) => paidResponse.headers.get(name));
      if (!settlement?.success || !settlement.transaction) {
        throw new Error("The endpoint returned data, but Hedera settlement was not confirmed");
      }
      const transactionId = settlement.transaction;
      const hashscanUrl = hashscanTransactionUrl(transactionId);
      event("payment.settled", "Settled on Hedera testnet", "The x402 payment is confirmed and independently verifiable.", {
        success: true,
        transactionId,
        payer: settlement.payer,
        hashscanUrl,
      });
      event("data.received", "Paid signal unlocked", `${plan.productId} data is now available to the agent.`, {
        productId: plan.productId,
        providerId: body && typeof body === "object" ? (body as Record<string, unknown>).providerId : undefined,
      });

      const recommendation = await this.advisor.analyze({ objective, portfolio, plan, paidData: body });
      event("analysis.completed", "Portfolio recommendation ready", recommendation.summary, {
        source: recommendation.source,
        fallbackReason: recommendation.fallbackReason,
        action: recommendation.action,
        confidence: recommendation.confidence,
      });
      return {
        id,
        status: "completed",
        objective,
        budgetAtomic: budgetAtomic.toString(),
        spentAtomic: product.priceAtomic,
        plan,
        purchase: {
          productId: plan.productId,
          params: plan.params,
          amountAtomic: product.priceAtomic,
          asset: product.asset,
          transactionId,
          hashscanUrl,
          data: body,
        },
        recommendation,
        events,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent run failed";
      event("run.failed", "Run stopped safely", message);
      return {
        id,
        status: "failed",
        objective,
        budgetAtomic: budgetAtomic.toString(),
        spentAtomic: "0",
        events,
        error: message,
      };
    }
  }
}
