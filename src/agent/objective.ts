export type ObjectiveIntent = "research" | "advise" | "act";

/**
 * Classify free-text prompts so Mode 2–4 don't always force a rebalance
 * when the user asked for research or recommendations.
 */
export function classifyObjective(objective: string, userProvided: boolean): ObjectiveIntent {
  const text = objective.trim().toLowerCase();
  if (!text) return "act";

  const research =
    /\b(research|investigat|brows|explor|trait|direction|tell me about|learn about|what (are|can|could)|look into|study)\b/.test(text)
    || /\bdon'?t\s+(make|trade|swap|execute|buy|sell)\b/.test(text)
    || /\bdo not\s+(make|trade|swap|execute|buy|sell)\b/.test(text);

  const explicitAct =
    /\b(rebalance|swap|trade|execute|buy|sell|rotate|fix (the )?mix|manage my)\b/.test(text);

  if (research && !explicitAct) return "research";
  if (explicitAct) return "act";
  if (!userProvided) return "act";

  const advise =
    /\b(recommend|advice|advis|how (is|are|do)|what should|check (the )?market|how's the market|status|update)\b/.test(text);
  if (advise) return "advise";

  // Free-form chat defaults to advise so autonomous Mode 4 doesn't trade on every message.
  return "advise";
}

/** Soft focus asset mentioned in the prompt (e.g. "source" → SAUCE). */
export function focusSymbolFromObjective(objective: string): "HBAR" | "USDC" | "SAUCE" | undefined {
  const text = objective.toLowerCase();
  if (/\b(sauce|source|saucerswap)\b/.test(text)) return "SAUCE";
  if (/\busdc\b/.test(text)) return "USDC";
  if (/\bhbar\b/.test(text)) return "HBAR";
  return undefined;
}

export function formatTradeAmount(value: number | string | undefined): string {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return String(value ?? "?");
  return amount.toFixed(4).replace(/\.?0+$/, "");
}
