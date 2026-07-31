import { useEffect, useState } from "react";
import type { Proposal } from "@/lib/agent-types";
import { countdown, num, usd } from "@/lib/format";
import { useVariant } from "@/lib/variants";

function useCountdown(expiresAt: number) {
  const [left, setLeft] = useState(() => expiresAt - Date.now());
  useEffect(() => {
    const t = setInterval(() => setLeft(expiresAt - Date.now()), 500);
    return () => clearInterval(t);
  }, [expiresAt]);
  return left;
}

function Terms({ proposal }: { proposal: Proposal }) {
  const rows: [string, string][] = [
    ["Swap", `${num(proposal.amount, 0)} ${proposal.from} → ${proposal.to}`],
    ["Expected rate", `${proposal.expectedRate.toFixed(5)} ${proposal.to}/${proposal.from}`],
    ["Expected receive", usd(proposal.amount * proposal.expectedRate)],
    ["Max slippage", `${proposal.slippagePct.toFixed(2)}%`],
    ["Resulting position", proposal.resultingPosition],
  ];
  return (
    <dl className="mt-3 grid gap-1.5">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-4 text-[12.5px]">
          <dt className="text-ink-3">{k}</dt>
          <dd className="text-right font-mono text-[12px] text-ink tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Actions({
  onApprove,
  onDecline,
  left,
  busy,
}: {
  onApprove: () => void;
  onDecline: () => void;
  left: number;
  busy?: boolean;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onApprove}
        disabled={busy}
        className="rounded-control bg-signal px-3.5 py-2 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Waiting on wallet…" : "Approve in wallet"}
      </button>
      <button
        type="button"
        onClick={onDecline}
        disabled={busy}
        className="rounded-control border border-line px-3.5 py-2 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover disabled:opacity-50"
      >
        Decline
      </button>
      <span className="ml-auto font-mono text-[12px] text-orange tabular-nums">
        expires in {countdown(left)}
      </span>
    </div>
  );
}

function Warning() {
  return (
    <p className="mt-2.5 border-t border-line pt-2.5 text-[11.5px] leading-relaxed text-ink-3">
      Approving submits a real transaction on Hedera testnet. Once submitted it cannot be
      reversed — this is the last reversible moment.
    </p>
  );
}

export function ProposalGate({
  proposal,
  onApprove,
  onDecline,
  busy,
}: {
  proposal: Proposal;
  onApprove: () => void;
  onDecline: () => void;
  busy?: boolean;
}) {
  const variant = useVariant("proposal");
  const left = useCountdown(proposal.expiresAt);

  const header = (
    <div className="flex items-center gap-2">
      <span
        className="size-2 rounded-full bg-orange"
        style={{ animation: "pulse-ring 2s ease-out infinite" }}
      />
      <span className="text-[10.5px] font-medium tracking-[0.09em] text-orange uppercase">
        Awaiting your approval
      </span>
    </div>
  );

  const rationale = (
    <p className="mt-2 max-w-xl text-[12.5px] leading-relaxed text-ink-2">{proposal.reason}</p>
  );

  const breach = proposal.breach && (
    <p className="mt-2 rounded-control border border-orange/25 bg-orange-soft px-2.5 py-1.5 text-[11.5px] text-orange">
      {proposal.breach} — autonomous execution was blocked for this action.
    </p>
  );

  if (variant === "Sticky bar") {
    return (
      <div className="sticky bottom-0 z-20 -mx-1 rounded-lg border border-orange/30 bg-card/95 p-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {header}
          <span className="font-mono text-[12.5px] text-ink tabular-nums">
            {num(proposal.amount, 0)} {proposal.from} → {proposal.to} @{" "}
            {proposal.expectedRate.toFixed(5)}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="font-mono text-[12px] text-orange tabular-nums">
              {countdown(left)}
            </span>
            <button
              type="button"
              onClick={onDecline}
              disabled={busy}
              className="rounded-control border border-line px-3 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-hover disabled:opacity-50"
            >
              Decline
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={busy}
              className="rounded-control bg-signal px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Waiting…" : "Approve in wallet"}
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-ink-3">
          Irreversible once submitted · {proposal.resultingPosition}
        </p>
      </div>
    );
  }

  if (variant === "Takeover") {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/25 p-4 backdrop-blur-sm">
        <div
          className="w-full max-w-md rounded-xl border border-line bg-card p-5 shadow-xl"
          style={{ animation: "fade-up 260ms cubic-bezier(0.23,1,0.32,1) both" }}
        >
          {header}
          <h2 className="mt-2 text-[16px] font-semibold text-ink">
            The agent wants to rotate {num(proposal.amount, 0)} {proposal.from}
          </h2>
          {rationale}
          {breach}
          <Terms proposal={proposal} />
          <Warning />
          <Actions onApprove={onApprove} onDecline={onDecline} left={left} busy={busy} />
        </div>
      </div>
    );
  }

  // Inline
  return (
    <div className="mt-2 w-full max-w-lg rounded-lg border border-orange/30 bg-card p-3.5">
      {header}
      {rationale}
      {breach}
      <Terms proposal={proposal} />
      <Warning />
      <Actions onApprove={onApprove} onDecline={onDecline} left={left} busy={busy} />
    </div>
  );
}
