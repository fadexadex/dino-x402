import type {
  AgentRecommendation,
  PortfolioHolding,
  PurchasePlan,
} from "./types.js";
import type { DataProduct } from "../core/provider.js";

interface MistralConfig {
  apiKey?: string;
  model: string;
}

const JSON_FENCE = /^```(?:json)?\s*|\s*```$/gi;

const parseObject = (text: string): Record<string, unknown> => {
  const cleaned = text.trim().replace(JSON_FENCE, "").trim();
  const parsed: unknown = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model response was not a JSON object");
  }
  return parsed as Record<string, unknown>;
};

const safeReason = (error: unknown): string => {
  if (error instanceof DOMException && error.name === "AbortError") return "Mistral timed out";
  if (error instanceof Error && error.message === "Mistral is not configured") return error.message;
  if (error instanceof Error && /^Mistral HTTP \d{3}$/.test(error.message)) return error.message;
  return "Mistral returned an unusable response";
};

export class MistralAdvisor {
  constructor(private readonly config: MistralConfig) {}

  private async complete(system: string, user: string): Promise<Record<string, unknown>> {
    if (!this.config.apiKey) throw new Error("Mistral is not configured");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Mistral HTTP ${response.status}`);
      const body = await response.json() as {
        choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part) => part.text ?? "").join("")
          : "";
      if (!text) throw new Error("Mistral returned no content");
      return parseObject(text);
    } finally {
      clearTimeout(timeout);
    }
  }

  async choosePurchase(args: {
    objective: string;
    requestedSymbol: string;
    portfolio: PortfolioHolding[];
    products: DataProduct[];
    budgetAtomic: string;
  }): Promise<PurchasePlan> {
    const fallback = (): PurchasePlan => {
      const affordable = args.products
        .filter((product) => BigInt(product.priceAtomic) <= BigInt(args.budgetAtomic))
        .sort((a, b) => BigInt(a.priceAtomic) < BigInt(b.priceAtomic) ? -1 : 1)[0];
      if (!affordable) throw new Error("No catalog product fits the spend cap");
      const params: Record<string, string> = { symbol: args.requestedSymbol };
      if (affordable.paramsSchema.date?.required) params.date = new Date().toISOString().slice(0, 10);
      return {
        productId: affordable.id,
        params,
        reason: `Buy the least expensive relevant signal for ${args.requestedSymbol}.`,
        source: "deterministic",
      };
    };

    try {
      const result = await this.complete(
        "You are a cautious autonomous portfolio agent. Choose exactly one affordable catalog product. Return only JSON with productId, symbol, optional date, and reason. Never invent products or symbols.",
        JSON.stringify(args),
      );
      const productId = typeof result.productId === "string" ? result.productId : "";
      const symbol = typeof result.symbol === "string" ? result.symbol.toUpperCase() : "";
      const product = args.products.find((item) => item.id === productId);
      if (!product || BigInt(product.priceAtomic) > BigInt(args.budgetAtomic)) {
        throw new Error("Model selected an unavailable or over-budget product");
      }
      if (symbol !== args.requestedSymbol) throw new Error("Model changed the allowlisted symbol");
      const params: Record<string, string> = { symbol };
      if (product.paramsSchema.date?.required) {
        const date = typeof result.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(result.date)
          ? result.date
          : new Date().toISOString().slice(0, 10);
        params.date = date;
      }
      return {
        productId,
        params,
        reason: typeof result.reason === "string" ? result.reason.slice(0, 280) : "Selected by Mistral within policy.",
        source: "mistral",
      };
    } catch (error) {
      return { ...fallback(), fallbackReason: safeReason(error) };
    }
  }

  async analyze(args: {
    objective: string;
    portfolio: PortfolioHolding[];
    plan: PurchasePlan;
    paidData: unknown;
  }): Promise<AgentRecommendation> {
    const fallback = (reason: string): AgentRecommendation => ({
      summary: `The agent purchased ${args.plan.productId} data for ${args.plan.params.symbol}. Review the returned signal before changing allocations.`,
      action: "watch",
      confidence: 0.5,
      rationale: ["The x402 purchase settled successfully.", "No model-generated investment conclusion is being substituted."],
      source: "deterministic",
      fallbackReason: reason,
    });
    try {
      const result = await this.complete(
        "You are a conservative portfolio analyst. Use only the supplied paid data. Return only JSON: summary (string), action (hold|watch|rebalance), confidence (0..1), rationale (array of short strings). Do not claim to execute trades and do not invent prices.",
        JSON.stringify(args),
      );
      const action = result.action;
      const rationale = result.rationale;
      const confidence = result.confidence;
      if (
        typeof result.summary !== "string" ||
        !["hold", "watch", "rebalance"].includes(String(action)) ||
        typeof confidence !== "number" || confidence < 0 || confidence > 1 ||
        !Array.isArray(rationale) || !rationale.every((item) => typeof item === "string")
      ) throw new Error("Invalid analysis schema");
      return {
        summary: result.summary.slice(0, 500),
        action: action as AgentRecommendation["action"],
        confidence,
        rationale: (rationale as string[]).slice(0, 4).map((item) => item.slice(0, 240)),
        source: "mistral",
      };
    } catch (error) {
      return fallback(safeReason(error));
    }
  }
}
