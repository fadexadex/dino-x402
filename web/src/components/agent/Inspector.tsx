import { useMemo } from "react";
import type { AgentEvent, Tick } from "@/lib/agent-types";
import { clock, hashscan, micro, shortHash } from "@/lib/format";
import { LiveGraph } from "./LiveGraph";
import { SpendLedger, type Spend } from "./SpendLedger";

export type InspectorView = "graph" | "ledger" | "trace";

export function Inspector({
  view,
  ticks,
  markers,
  events,
  focusId,
  tall = false,
  onView,
  onFocus,
  onClose,
  spend,
  weights = [],
}: {
  view: InspectorView;
  ticks: Tick[];
  markers: { t: number; eventId: string }[];
  events: AgentEvent[];
  focusId: string | null;
  tall?: boolean;
  onView: (v: InspectorView) => void;
  onFocus?: (id: string) => void;
  onClose: () => void;
  spend?: Spend;
  weights?: Array<{ t: number; weight: number }>;
}) {
  const focused = events.find((e) => e.id === focusId) ?? null;
  const tabs: { id: InspectorView; label: string }[] = [
    { id: "graph", label: "Graph" },
    { id: "trace", label: "Trace" },
    { id: "ledger", label: "Ledger" },
  ];

  const annotations = useMemo(
    () =>
      events
        .filter((e) => e.purchase || e.proposal || e.settlement || e.step === "verify" || e.id === focusId)
        .map((e) => ({ t: e.at, eventId: e.id, label: `${e.step} · ${e.title}` })),
    [events, focusId],
  );

  // Guarantee the focused moment has a tick so the tracer can land even when
  // history is sparse or the event only carries a point price.
  const graphTicks = useMemo(() => {
    if (!focused) return ticks;
    const hasNearby = ticks.some((tick) => Math.abs(tick.t - focused.at) < 1_000);
    if (hasNearby) return ticks;
    const eventPrice = (focused as AgentEvent & { price?: number }).price;
    const price =
      (typeof eventPrice === "number" && eventPrice > 0 ? eventPrice : undefined)
      ?? ticks[ticks.length - 1]?.price
      ?? ticks[0]?.price;
    if (!(typeof price === "number" && price > 0)) return ticks;
    return [...ticks, { t: focused.at, price, provenance: focused.provenance ?? ("live" as const) }].sort(
      (a, b) => a.t - b.t,
    );
  }, [ticks, focused]);

  const graphEvents = useMemo(() => {
    const fromEvents = events.filter((e) => e.purchase || e.proposal || e.settlement || e.step === "verify" || e.step === "acquire" || e.step === "propose");
    if (fromEvents.length > 0) return fromEvents;
    // Fall back to chart markers so the list stays useful after cache-hit runs.
    return markers.map((m) => {
      const match = events.find((e) => e.id === m.eventId);
      return match ?? { id: m.eventId, step: "record" as const, at: m.t, title: "Marked on chart" };
    });
  }, [events, markers]);

  return (
    <aside
      className="flex h-full min-h-0 flex-col gap-3 border-l border-line bg-paper p-4"
      style={{ animation: "fade-in 220ms ease-out both" }}
    >
      <div className="flex items-center gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onView(t.id)}
            className={`rounded-control px-2.5 py-1 text-[12px] font-medium transition-colors ${
              view === t.id ? "bg-inset text-ink" : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="ml-auto rounded-control px-2 py-1 text-[13px] text-ink-3 hover:bg-hover"
        >
          ✕
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {view === "graph" && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="min-h-[440px] flex-[5]">
              <LiveGraph
                ticks={graphTicks}
                markers={markers}
                annotations={annotations}
                focusT={focused?.at ?? null}
                tall={tall}
                onMarker={(id) => onFocus?.(id)}
                weights={weights}
              />
            </div>

            <div className="min-h-0 flex-[2] shrink overflow-auto pr-0.5">
              {focused && (
                <div className="mb-2 rounded-lg border border-line bg-card p-3">
                  <p className="text-[10.5px] tracking-[0.09em] text-ink-3 uppercase">
                    On the chart · {focused.step} · {clock(focused.at)}
                  </p>
                  <p className="mt-1 text-[13px] font-medium text-ink">{focused.title}</p>
                  {focused.detail && (
                    <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{focused.detail}</p>
                  )}
                  <button
                    type="button"
                    onClick={() => onView("trace")}
                    className="mt-2 text-[11.5px] text-signal hover:underline"
                  >
                    Open full trace →
                  </button>
                </div>
              )}
              <div className="rounded-lg border border-line bg-card p-3">
                <p className="text-[10.5px] tracking-[0.09em] text-ink-3 uppercase">
                  Steps the agent placed on this chart
                </p>
                <ol className="mt-1.5 grid gap-0.5">
                  {graphEvents.length === 0 && (
                    <li className="text-[11.5px] text-ink-3">Nothing marked yet this run.</li>
                  )}
                  {graphEvents.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => onFocus?.(e.id)}
                        className={`-mx-1 flex w-full items-baseline gap-2 rounded-control px-1 py-0.5 text-left text-[11.5px] transition-colors hover:bg-hover ${
                          focusId === e.id ? "bg-signal-soft" : ""
                        }`}
                      >
                        <span className="font-mono text-ink-3 tabular-nums">{clock(e.at)}</span>
                        <span className="min-w-0 flex-1 truncate text-ink-2">{e.title}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
                Only data the agent paid for is drawn. Shaded bands are moments with no purchased
                data — the line breaks there rather than interpolating.
              </p>
            </div>
          </div>
        )}

        {view !== "graph" && (
          <div className="min-h-0 flex-1 overflow-auto">
            {view === "ledger" && <SpendLedger spend={spend} />}



        {view === "trace" && (
          <div className="grid gap-3">
            {focused ? (
              <div className="rounded-lg border border-line bg-card p-3">
                <p className="text-[10.5px] tracking-[0.09em] text-ink-3 uppercase">
                  {focused.step} · {clock(focused.at)}
                </p>
                <p className="mt-1 text-[13px] font-medium text-ink">{focused.title}</p>
                {focused.detail && (
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">{focused.detail}</p>
                )}
                <button
                  type="button"
                  onClick={() => onView("graph")}
                  className="mt-2 text-[11.5px] text-signal hover:underline"
                >
                  Show this moment on the graph →
                </button>
                {focused.purchase && (
                  <a
                    href={hashscan(focused.purchase.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block font-mono text-[11px] text-signal"
                  >
                    {micro(focused.purchase.costUsd)} · {shortHash(focused.purchase.txHash)} ↗
                  </a>
                )}
                {focused.settlement && (
                  <a
                    href={hashscan(focused.settlement.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block font-mono text-[11px] text-signal"
                  >
                    {shortHash(focused.settlement.txHash)} ↗
                  </a>
                )}
              </div>
            ) : (
              <p className="text-[12px] text-ink-3">
                Click any step in the stream, or a trade marker on the graph, to inspect it here.
              </p>
            )}
            <ol className="grid gap-1">
              {events.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => onFocus?.(e.id)}
                    className={`-mx-1 flex w-full items-baseline gap-2 rounded-control px-1 py-0.5 text-left text-[11.5px] transition-colors hover:bg-hover ${
                      focusId === e.id ? "bg-signal-soft" : ""
                    }`}
                  >
                    <span className="font-mono text-ink-3 tabular-nums">{clock(e.at)}</span>
                    <span className="w-16 shrink-0 text-[10.5px] tracking-[0.06em] text-ink-3 uppercase">
                      {e.step}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ink-2">{e.title}</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}
          </div>
        )}
      </div>

    </aside>
  );
}
