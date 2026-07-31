import { num, usd } from "@/lib/format";
import type { Holding } from "@/lib/agent-types";

type RunItem = { id: string; label: string; status: string; tone?: "orange" | "green" | "muted" };

function shortStatus(status: string): string {
  if (status === "waiting_approval") return "waiting";
  if (status === "completed") return "done";
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  return status;
}

function qtyDigits(asset: string): number {
  return asset === "HBAR" ? 4 : asset === "SAUCE" ? 2 : 2;
}

export function RunsRail({
  pendingCount,
  holdings = [],
  objective,
  runs = [],
  loadingHoldings = false,
}: {
  pendingCount: number;
  holdings?: Holding[];
  objective?: string;
  runs?: RunItem[];
  loadingHoldings?: boolean;
}) {
  const total = holdings.reduce((sum, holding) => sum + holding.usd, 0);
  const valued = total > 0;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="min-w-0 rounded-lg border border-line bg-card p-3">
        <p className="text-[10.5px] font-medium tracking-[0.09em] text-ink-3 uppercase">
          Objective
        </p>
        <p className="mt-1.5 break-words text-[12px] leading-relaxed text-ink-2">{objective || "No objective configured yet."}</p>
        <div className="mt-2.5 border-t border-line pt-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11.5px] text-ink-3">Balances</span>
            <span className="font-mono text-[13px] font-medium text-ink tabular-nums">
              {loadingHoldings && holdings.length === 0
                ? "…"
                : valued
                  ? usd(total)
                  : holdings.length
                    ? "No USD yet"
                    : usd(0)}
            </span>
          </div>
          <p className="mt-1 text-[10.5px] leading-snug text-ink-3">
            {loadingHoldings && holdings.length === 0
              ? "Fetching token amounts and USD marks…"
              : valued
                ? "Qty from Mirror · USD from CoinGecko (USDC pegged $1). HashPack may use a different testnet mark."
                : holdings.length
                  ? "Token quantities from Mirror. Waiting on USD marks…"
                  : "Connect a wallet to load live token amounts."}
          </p>
          {holdings.length > 0 && (
            <div className="mt-2 flex items-baseline justify-between gap-2 text-[10px] tracking-[0.06em] text-ink-3 uppercase">
              <span>Token</span>
              <span>{valued ? "Qty · USD" : "Qty"}</span>
            </div>
          )}
          <ul className="mt-1 grid gap-1">
            {holdings.length === 0 ? (
              <li className="text-[11.5px] text-ink-3">
                {loadingHoldings ? "Loading…" : "No Mirror balances yet for this account."}
              </li>
            ) : holdings.map((holding) => (
              <li key={holding.asset} className="flex min-w-0 items-baseline justify-between gap-2 text-[11.5px]">
                <span className="shrink-0 font-medium text-ink">{holding.asset}</span>
                <span
                  className="min-w-0 truncate text-right font-mono text-ink-2 tabular-nums"
                  title={`${holding.amount} ${holding.asset}${valued ? ` ≈ ${usd(holding.usd)}` : " (token amount)"}`}
                >
                  {num(holding.amount, qtyDigits(holding.asset))}
                  {valued ? <span className="text-ink-3"> · {usd(holding.usd)}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="max-h-[46vh] min-w-0 shrink-0 overflow-y-auto overflow-x-hidden rounded-lg border border-line bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10.5px] font-medium tracking-[0.09em] text-ink-3 uppercase">Runs</p>
          {pendingCount > 0 && (
            <span className="shrink-0 rounded-full bg-orange-soft px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-orange">
              {pendingCount} waiting
            </span>
          )}
        </div>
        <ul className="mt-2 grid gap-0.5">
          {runs.map((item, index) => (
            <li key={item.id} className="min-w-0">
              <button
                type="button"
                title={item.label}
                className={`w-full min-w-0 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-hover ${index === 0 ? "bg-hover-2" : ""}`}
              >
                <p className="truncate text-[12px] font-medium text-ink">{item.label}</p>
                <span
                  className={`text-[11px] ${
                    item.tone === "orange"
                      ? "text-orange"
                      : item.tone === "green"
                        ? "text-green"
                        : "text-ink-3"
                  }`}
                >
                  {shortStatus(item.status)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-2 border-t border-line pt-2 text-[11px] leading-snug text-ink-3">
          {runs.length ? "Earlier runs are available in the activity stream." : "No completed runs yet."}
        </p>
      </div>
    </div>
  );
}
