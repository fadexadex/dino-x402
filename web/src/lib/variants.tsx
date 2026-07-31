/**
 * The archive's visual defaults, intentionally fixed for production.
 * Its VariantSwitcher/localStorage design gallery is not shipped.
 */
const defaults = {
  font: "Inter Tight",
  eventCard: "Trace line",
  receipt: "Inline chip",
  proposal: "Inline",
  autonomy: "Vertical dial",
  rightNow: "Left rail",
  watch: "Header pill",
  graph: "Overlay",
  graphPlacement: "Split right",
  ledger: "Split bar",
  kill: "Header icon",
  loader: "Drive",
} as const;

export type VariantKey = keyof typeof defaults;
export function useVariant<K extends VariantKey>(key: K): string { return defaults[key]; }
export function useVariants() { return { variants: defaults as Record<VariantKey, string>, density: "comfortable" as "comfortable" | "compact" }; }
