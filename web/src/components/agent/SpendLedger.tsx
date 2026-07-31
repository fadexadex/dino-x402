import { micro, usd } from "@/lib/format";
import { useVariant } from "@/lib/variants";

export type Spend = { dataAllTime?: number; paidReadsAllTime?: number; tradeVolumeAllTime?: number; tradesAllTime?: number; dataToday?: number; tradeVolumeToday?: number; networkFeesAllTime?: number; unit?: "USD" | "HBAR" };

const amount = (value: number, unit: Spend["unit"]) => unit === "HBAR" ? `${value.toFixed(8).replace(/\.?0+$/, "")} HBAR` : micro(value);

export function SpendLedger({ spend = {}, rows = [] }: { spend?: Spend; rows?: { run: string; data: number; reads: number; trade: number; outcome: string }[] }) {
  const variant = useVariant("ledger");
  const dataPct = 1.2;

  if (variant === "Table") {
    return (
      <div className="overflow-hidden rounded-lg border border-line bg-card">
        <table className="w-full text-[11.5px]">
          <thead>
            <tr className="border-b border-line text-ink-3">
              <th className="px-3 py-1.5 text-left font-medium">Run</th>
              <th className="px-3 py-1.5 text-right font-medium">Data</th>
              <th className="px-3 py-1.5 text-right font-medium">Reads</th>
              <th className="px-3 py-1.5 text-right font-medium">Traded</th>
              <th className="px-3 py-1.5 text-right font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {rows.map((r) => (
              <tr key={r.run} className="border-b border-line last:border-0">
                <td className="px-3 py-1.5 text-ink-3">{r.run}</td>
                <td className="px-3 py-1.5 text-right text-signal">{micro(r.data)}</td>
                <td className="px-3 py-1.5 text-right text-ink-3">{r.reads}</td>
                <td className="px-3 py-1.5 text-right text-ink">
                  {r.trade ? usd(r.trade) : "—"}
                </td>
                <td className="px-3 py-1.5 text-right font-sans text-ink-2">{r.outcome}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <p className="text-[10.5px] font-medium tracking-[0.09em] text-ink-3 uppercase">Spend</p>
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-inset">
        <div className="h-full bg-signal" style={{ width: `${dataPct}%` }} />
        <div className="h-full flex-1 bg-ink/70" />
      </div>
      <dl className="mt-2.5 grid gap-1.5 text-[11.5px]">
        <div className="flex justify-between">
          <dt className="flex items-center gap-1.5 text-ink-3">
            <span className="size-1.5 rounded-full bg-signal" /> Intelligence (x402)
          </dt>
          <dd className="font-mono text-ink tabular-nums">
            {amount(spend.dataAllTime ?? 0, spend.unit)} · {spend.paidReadsAllTime ?? 0} reads
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="flex items-center gap-1.5 text-ink-3">
            <span className="size-1.5 rounded-full bg-ink/70" /> Moved via trades
          </dt>
          <dd className="font-mono text-ink tabular-nums">
            {spend.unit === "HBAR" ? amount(spend.tradeVolumeAllTime ?? 0, spend.unit) : usd(spend.tradeVolumeAllTime ?? 0)} · {spend.tradesAllTime ?? 0} trades
          </dd>
        </div>
        <div className="flex justify-between border-t border-line pt-1.5">
          <dt className="text-ink-3">Today</dt>
          <dd className="font-mono text-ink tabular-nums">
            {amount(spend.dataToday ?? 0, spend.unit)} data · {spend.unit === "HBAR" ? amount(spend.tradeVolumeToday ?? 0, spend.unit) : usd(spend.tradeVolumeToday ?? 0)} traded
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-3">Network fees, all time</dt>
          <dd className="font-mono text-ink tabular-nums">{amount(spend.networkFeesAllTime ?? 0, spend.unit)}</dd>
        </div>
      </dl>
    </div>
  );
}
