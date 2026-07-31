import type { AgentEvent } from "@/lib/agent-types";
import { clock, hashscan, shortHash } from "@/lib/format";
import { useVariant } from "@/lib/variants";
import { Receipt } from "./Receipt";
import { LoadingState } from "../kit/LoadingState";

const STEP_LABEL: Record<string, string> = {
  trigger: "Trigger",
  observe: "Observe",
  judge: "Judge",
  acquire: "Acquire",
  reason: "Reason",
  propose: "Propose",
  gate: "Gate",
  decide: "Decide",
  execute: "Execute",
  verify: "Verify",
  record: "Record",
  noop: "Outcome",
};

const toneText = (t?: AgentEvent["tone"]) =>
  t === "signal"
    ? "text-signal"
    : t === "green"
      ? "text-green"
      : t === "orange"
        ? "text-orange"
        : "text-ink";

const toneDot = (t?: AgentEvent["tone"]) =>
  t === "signal"
    ? "bg-signal"
    : t === "green"
      ? "bg-green"
      : t === "orange"
        ? "bg-orange"
        : "bg-ink-3";

function Settlement({ event }: { event: AgentEvent }) {
  const loaderVariant = useVariant("loader");
  const s = event.settlement;
  if (!s) return null;
  const confirmed = s.status === "confirmed" || Boolean(s.confirmedAt);
  return (
    <div
      className="mt-2 w-full max-w-lg rounded-control border border-line bg-card px-3 py-2.5"
      style={{ animation: confirmed ? "fade-in 350ms ease-out both" : undefined }}
    >
      <div className="flex items-center justify-between gap-3">
        {confirmed ? (
          <span className="flex items-center gap-2 text-[13px] font-medium text-green">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6L9 17l-5-5" />
            </svg>
            Verified on Hedera
            {s.confirmedAt && s.submittedAt ? (
              <span className="font-mono text-[11px] font-normal text-ink-3 tabular-nums">
                {((s.confirmedAt - s.submittedAt) / 1000).toFixed(1)}s
              </span>
            ) : null}
          </span>
        ) : (
          <LoadingState
            label="Awaiting consensus"
            variant={loaderVariant}
            startedAt={s.submittedAt}
            tone="signal"
          />
        )}
        <span
          className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium tracking-[0.06em] uppercase ${
            confirmed
              ? "border-green/30 bg-green-soft text-green"
              : "border-orange/30 bg-orange-soft text-orange"
          }`}
        >
          {confirmed ? "Final" : "Not yet final"}
        </span>
      </div>
      {s.txHash && s.txHash !== "pending" && (
        <a
          href={hashscan(s.txHash)}
          target="_blank"
          rel="noreferrer"
          className="animated-underline mt-2 inline-block font-mono text-[11px] text-ink-3"
        >
          {shortHash(s.txHash)} ↗
        </a>
      )}
    </div>
  );
}

export function EventCard({
  event,
  onInspect,
  onGraph,
  children,
}: {
  event: AgentEvent;
  onInspect?: (event: AgentEvent) => void;
  onGraph?: (event: AgentEvent) => void;
  children?: React.ReactNode;
}) {
  const variant = useVariant("eventCard");
  const step = STEP_LABEL[event.step] ?? event.step;
  const onChart = !!(event.purchase || event.proposal || event.settlement || event.step === "verify");

  const body = (
    <>
      {event.detail && (
        <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink-2">{event.detail}</p>
      )}
      {event.rows && (
        <ul className="mt-2 flex flex-col gap-0.5">
          {event.rows.map((r) => (
            <li key={r.primary} className="flex items-center gap-3 text-[12px]">
              <span className="w-14 shrink-0 font-medium text-ink">{r.primary}</span>
              <span className="font-mono text-[11.5px] text-ink-3 tabular-nums">{r.secondary}</span>
            </li>
          ))}
        </ul>
      )}
      {event.purchase && (
        <div className="mt-2">
          <Receipt purchase={event.purchase} />
        </div>
      )}
      {event.settlement && <Settlement event={event} />}
      {onChart && onGraph && (
        <button
          type="button"
          onClick={() => onGraph(event)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-control border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-hover hover:text-ink"
        >
          <span className="h-px w-3 bg-signal" />
          See this moment on the graph
        </button>
      )}
      {children}
    </>
  );


  if (variant === "Terminal") {
    return (
      <div
        className="group font-mono text-[12px] leading-relaxed"
        style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <button
          type="button"
          onClick={() => onInspect?.(event)}
          className="flex w-full items-start gap-2 rounded-control px-1 py-0.5 text-left hover:bg-hover"
        >
          <span className="text-ink-3 tabular-nums">{clock(event.at)}</span>
          <span className={`w-[68px] shrink-0 uppercase ${toneText(event.tone)}`}>{step}</span>
          <span className="min-w-0 flex-1 font-sans text-[12.5px] font-medium text-ink">
            {event.title}
          </span>
        </button>
        <div className="pl-[7.2rem] font-sans">{body}</div>
      </div>
    );
  }

  if (variant === "Card stack") {
    return (
      <article
        className="rounded-lg border border-line bg-card p-3.5 shadow-[0_1px_0_0_var(--line)]"
        style={{ animation: "fade-up 320ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <button
          type="button"
          onClick={() => onInspect?.(event)}
          className="flex w-full items-center gap-2 text-left"
        >
          <span
            className={`rounded-full border border-line px-2 py-0.5 text-[10.5px] font-medium tracking-[0.07em] uppercase ${toneText(event.tone)}`}
          >
            {step}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
            {event.title}
          </span>
          <span className="font-mono text-[11px] text-ink-3 tabular-nums">{clock(event.at)}</span>
        </button>
        {body}
      </article>
    );
  }

  // Trace line
  return (
    <div
      className="relative pl-6"
      style={{ animation: "fade-up 320ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <span aria-hidden className="absolute top-2.5 bottom-[-14px] left-[5px] w-px bg-line" />
      <span
        aria-hidden
        className={`absolute top-[7px] left-[1.5px] size-2 rounded-full ring-4 ring-paper ${toneDot(event.tone)}`}
      />
      <button
        type="button"
        onClick={() => onInspect?.(event)}
        className="-mx-1.5 flex w-full items-baseline gap-2 rounded-control px-1.5 py-0.5 text-left transition-colors hover:bg-hover"
      >
        <span className="text-[13px] font-medium text-ink">{event.title}</span>
        <span className="text-[10.5px] tracking-[0.08em] text-ink-3 uppercase">{step}</span>
        <span className="ml-auto font-mono text-[11px] text-ink-3 tabular-nums">
          {clock(event.at)}
        </span>
      </button>
      {body}
    </div>
  );
}
