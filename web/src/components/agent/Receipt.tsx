import type { Purchase } from "@/lib/agent-types";
import { hashscan, micro, shortHash } from "@/lib/format";
import { useVariant } from "@/lib/variants";

const cost = (purchase: Purchase) => purchase.costLabel ?? micro(purchase.costUsd);

function ProvenanceDot({ p }: { p: Purchase["provenance"] }) {
  const tone =
    p === "live" ? "bg-green" : p === "cached" ? "bg-ink-3" : "bg-orange";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-3 uppercase tracking-[0.08em]">
      <span className={`size-1.5 rounded-full ${tone}`} />
      {p}
    </span>
  );
}

export function Receipt({ purchase }: { purchase: Purchase }) {
  const variant = useVariant("receipt");

  if (variant === "Inline chip") {
    return (
      <a
        href={hashscan(purchase.txHash)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex max-w-full items-center gap-2 rounded-control border border-signal/25 bg-signal-soft px-2 py-1 text-[12px] transition-colors hover:border-signal/50"
      >
        <span className="font-mono text-[11px] font-medium text-signal tabular-nums">402</span>
        <span className="truncate text-ink-2">{purchase.label}</span>
        <span className="font-mono text-[11.5px] font-medium text-ink tabular-nums">
          {cost(purchase)}
        </span>
        <span className="font-mono text-[11px] text-ink-3">{purchase.ms}ms</span>
      </a>
    );
  }

  if (variant === "Cost meter") {
    const pct = Math.min(100, (purchase.costUsd / 0.004) * 100);
    return (
      <div className="w-full max-w-md rounded-control border border-line bg-card p-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12.5px] font-medium text-ink">{purchase.label}</span>
          <span className="font-mono text-[13px] font-medium text-signal tabular-nums">
            {cost(purchase)}
          </span>
        </div>
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-inset">
          <div
            className="h-full rounded-full bg-signal transition-[width] duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between">
          <ProvenanceDot p={purchase.provenance} />
          <a
            href={hashscan(purchase.txHash)}
            target="_blank"
            rel="noreferrer"
            className="animated-underline font-mono text-[11px] text-ink-3"
          >
            {shortHash(purchase.txHash)}
          </a>
        </div>
      </div>
    );
  }

  // Receipt strip
  return (
    <div className="w-full max-w-lg overflow-hidden rounded-control border border-line bg-card">
      <div className="flex items-center gap-2 border-b border-line bg-hover px-3 py-1.5">
        <span className="font-mono text-[11px] font-medium text-signal">HTTP 402</span>
        <span className="text-[11.5px] text-ink-3">payment required · settled</span>
        <span className="ml-auto font-mono text-[11px] text-ink-3">{purchase.ms}ms</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-3 py-2.5 text-[12px]">
        <div className="col-span-2 flex justify-between">
          <dt className="text-ink-3">Data</dt>
          <dd className="text-ink">{purchase.label}</dd>
        </div>
        <div className="col-span-2 flex justify-between">
          <dt className="text-ink-3">Endpoint</dt>
          <dd className="truncate font-mono text-[11px] text-ink-2">{purchase.endpoint}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-3">Paid</dt>
          <dd className="font-mono font-medium text-signal tabular-nums">
            {cost(purchase)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-3">Source</dt>
          <dd>
            <ProvenanceDot p={purchase.provenance} />
          </dd>
        </div>
      </dl>
      <a
        href={hashscan(purchase.txHash)}
        target="_blank"
        rel="noreferrer"
        className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[11px] transition-colors hover:bg-hover"
      >
        <span className="font-mono text-ink-3">{shortHash(purchase.txHash)}</span>
        <span className="text-signal">View on HashScan ↗</span>
      </a>
    </div>
  );
}
