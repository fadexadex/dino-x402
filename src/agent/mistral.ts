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
    preferredProductId?: string;
  }): Promise<PurchasePlan> {
    const fallback = (): PurchasePlan => {
      const affordable = args.products
        .filter((product) => BigInt(product.priceAtomic) <= BigInt(args.budgetAtomic));
      const preferred = args.preferredProductId
        ? affordable.find((product) => product.id === args.preferredProductId)
        : undefined;
      // Prefer quote (24h change + volume) when affordable so thoughts can cite market tape.
      const quote = affordable.find((product) => product.id === "quote");
      const selected = preferred ?? quote ?? affordable.sort((a, b) => BigInt(a.priceAtomic) < BigInt(b.priceAtomic) ? -1 : 1)[0];
      if (!selected) throw new Error("No catalog product fits the spend cap");
      const params: Record<string, string> = { symbol: args.requestedSymbol };
      if (selected.paramsSchema.date?.required) params.date = new Date().toISOString().slice(0, 10);
      return {
        productId: selected.id,
        params,
        reason: selected.id === "quote"
          ? `Buy the CoinGecko quote for ${args.requestedSymbol} so we get price, 24h change, and volume for the decision.`
          : `Buy the best affordable CoinGecko signal for ${args.requestedSymbol}.`,
        source: "deterministic",
      };
    };

    try {
      const result = await this.complete(
        "You are a cautious autonomous portfolio agent. Prefer the quote product when affordable so the agent can cite 24h change and volume. Choose exactly one affordable catalog product. Return only JSON with productId, symbol, optional date, and reason. Never invent products or symbols.",
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

  /**
   * Answer the user's free-text objective using paid market insights + band context.
   * Used by the multi-asset runner so research / advise prompts don't collapse into
   * a robotic "bands are satisfied" line.
   */
  async briefObjective(args: {
    objective: string;
    intent: "research" | "advise" | "act";
    mode: number;
    focusSymbol?: string;
    insights: Array<{
      symbol: string;
      price?: number;
      change24hPercent?: number;
      volume24hUsd?: number;
      sentences: string[];
    }>;
    allocations: Array<{ symbol: string; allocationPct: number; usdValue: number }>;
    bands: Array<{ symbol: string; minPct: number; targetPct: number; maxPct: number }>;
    candidate: { action: string; fromSymbol?: string; toSymbol?: string; reason: string; amountUsd?: number };
  }): Promise<{ summary: string; thoughts: string[]; bullets: string[] }> {
    const fallback = (): { summary: string; thoughts: string[]; bullets: string[] } => {
      const focus = args.focusSymbol?.toUpperCase();
      const focusInsight = args.insights.find((item) => item.symbol.toUpperCase() === focus);
      const mix = args.allocations
        .map((item) => `${item.symbol} ${item.allocationPct.toFixed(1)}%`)
        .join(" · ");
      const thoughts = [
        focus
          ? `You asked about ${focus} — I'm grounding the answer in the paid CoinGecko read for that sleeve first.`
          : "You asked for market context, so I'm reading the paid CoinGecko tape before any recommendation.",
        ...(focusInsight?.sentences.slice(0, 2) ?? args.insights.flatMap((item) => item.sentences.slice(0, 1)).slice(0, 3)),
        args.candidate.action === "swap"
          ? `Allocation check: ${args.candidate.reason}`
          : `Allocation check: the book is near target (${mix}).`,
      ];
      const summary = focusInsight?.price !== undefined
        ? `${focus} is about $${focusInsight.price}${focusInsight.change24hPercent !== undefined ? ` (${focusInsight.change24hPercent >= 0 ? "+" : ""}${focusInsight.change24hPercent.toFixed(2)}% 24h)` : ""} on the paid CoinGecko read. Current mix: ${mix}. ${args.intent === "research" ? "No trades — research-only as requested." : "No rebalance needed unless you ask to act."}`
        : `Paid reads are in for ${args.insights.map((item) => item.symbol).join(", ")}. Current mix: ${mix}. ${args.intent === "research" ? "No trades — research-only as requested." : args.candidate.reason}`;
      return {
        summary: summary.slice(0, 500),
        thoughts: thoughts.filter(Boolean).slice(0, 6),
        bullets: [
          `Focus: ${focus ?? "full book"} · intent ${args.intent} · mode ${args.mode}.`,
          `Mix ${mix}.`,
          args.intent === "research" ? "No executable order was prepared." : "Bands and paid tape informed this answer.",
        ],
      };
    };

    try {
      const result = await this.complete(
        "You are Dino, a concise Hedera portfolio agent. Answer the user's objective using ONLY the supplied paid insights, allocations, and band candidate. Return JSON: summary (string, 1-3 sentences, plain English), thoughts (array of 3-6 short first-person reasoning lines), bullets (array of 2-4 short facts). If intent is research, do not recommend executing a trade. Do not invent prices.",
        JSON.stringify(args),
      );
      const summary = typeof result.summary === "string" ? result.summary.trim() : "";
      const thoughts = Array.isArray(result.thoughts) ? result.thoughts.filter((item): item is string => typeof item === "string") : [];
      const bullets = Array.isArray(result.bullets) ? result.bullets.filter((item): item is string => typeof item === "string") : [];
      if (!summary || thoughts.length === 0) throw new Error("Invalid brief schema");
      return {
        summary: summary.slice(0, 500),
        thoughts: thoughts.slice(0, 6).map((item) => item.slice(0, 280)),
        bullets: bullets.slice(0, 4).map((item) => item.slice(0, 240)),
      };
    } catch {
      return fallback();
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
