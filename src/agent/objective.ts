export type ObjectiveIntent = "research" | "advise" | "act";

/** Normalize common dictation / typo variants before intent matching. */
function normalizeObjective(objective: string): string {
  return objective
    .trim()
    .toLowerCase()
    // Speech-to-text often turns "trade" into "thread".
    .replace(/\bthreads?\b/g, "trade")
    .replace(/\btrait\b/g, "trade");
}

/**
 * Classify free-text prompts so Mode 2–4 don't always force a rebalance
 * when the user asked for research or recommendations.
 */
export function classifyObjective(objective: string, userProvided: boolean): ObjectiveIntent {
  const text = normalizeObjective(objective);
  if (!text) return "act";

  const research =
    /\b(research|investigat|brows|explor|direction|tell me about|learn about|what (are|can|could)|look into|study)\b/.test(text)
    || /\bdon'?t\s+(make|trade|swap|execute|buy|sell)\b/.test(text)
    || /\bdo not\s+(make|trade|swap|execute|buy|sell)\b/.test(text);

  const explicitAct =
    /\b(rebalance|swap|trade|execute|buy|sell|rotate|fix (the )?mix|manage my)\b/.test(text)
    || /\b(sample|demo|test|try|practice|approval)\b/.test(text)
    || /\bmake\b.+\b(for me|please)\b/.test(text)
    || /\b(can you|could you|please)\b.+\b(swap|trade|buy|sell)\b/.test(text);

  if (research && !explicitAct) return "research";
  if (explicitAct) return "act";
  if (!userProvided) return "act";

  const advise =
    /\b(recommend|advice|advis|how (is|are|do)|what should|check (the )?market|how's the market|status|update)\b/.test(text);
  if (advise) return "advise";

  // Free-form chat defaults to advise so autonomous Mode 4 doesn't trade on every message.
  return "advise";
}

function symbolToken(raw: string): "HBAR" | "USDC" | "SAUCE" | undefined {
  const value = raw.toLowerCase();
  if (value === "sauce" || value === "source" || value === "saucerswap") return "SAUCE";
  if (value === "usdc") return "USDC";
  if (value === "hbar") return "HBAR";
  return undefined;
}

/** Soft focus asset mentioned in the prompt (e.g. "source" → SAUCE). */
export function focusSymbolFromObjective(objective: string): "HBAR" | "USDC" | "SAUCE" | undefined {
  const text = normalizeObjective(objective);
  if (/\b(sauce|source|saucerswap)\b/.test(text)) return "SAUCE";
  if (/\busdc\b/.test(text)) return "USDC";
  if (/\bhbar\b/.test(text)) return "HBAR";
  return undefined;
}

/** Explicit "swap HBAR into USDC" style pair, when the user named both legs. */
export function parseSwapPairFromObjective(
  objective: string,
): { fromSymbol: "HBAR" | "USDC" | "SAUCE"; toSymbol: "HBAR" | "USDC" | "SAUCE" } | undefined {
  const text = normalizeObjective(objective);
  const match = text.match(
    /\b(hbar|usdc|sauce|source|saucerswap)\b[\s\S]{0,40}?\b(?:into|to|for|->|→)\b[\s\S]{0,40}?\b(hbar|usdc|sauce|source|saucerswap)\b/,
  );
  if (!match) return undefined;
  const fromSymbol = symbolToken(match[1] ?? "");
  const toSymbol = symbolToken(match[2] ?? "");
  if (!fromSymbol || !toSymbol || fromSymbol === toSymbol) return undefined;
  return { fromSymbol, toSymbol };
}

export function formatTradeAmount(value: number | string | undefined): string {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return String(value ?? "?");
  return amount.toFixed(4).replace(/\.?0+$/, "");
}
