// Ported from the provided sample kit (expandable agent trace),
// generalised to accept agent lifecycle rows and rewired onto design tokens.
import { useLayoutEffect, useRef, useState } from "react";
import { ShimmerLabel } from "./LoadingState";

export type TraceRow = {
  primary: string;
  secondary?: string;
  mono?: boolean;
  href?: string;
  tone?: "ink" | "signal" | "green" | "orange";
};

export function ThinkingTrace({
  activeLabel,
  doneLabel,
  rows,
  visible,
  working,
  query,
  defaultExpanded = true,
  onRowClick,
}: {
  activeLabel: string;
  doneLabel: string;
  rows: TraceRow[];
  visible: number;
  working: boolean;
  query?: string;
  defaultExpanded?: boolean;
  onRowClick?: (row: TraceRow, index: number) => void;
}) {
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? (working ? true : defaultExpanded);
  const traceRef = useRef<HTMLDivElement>(null);
  const [lineHeight, setLineHeight] = useState(0);

  useLayoutEffect(() => {
    if (traceRef.current) setLineHeight(traceRef.current.offsetHeight);
  }, [visible, expanded, rows.length]);

  return (
    <div className="flex w-full flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setManualExpanded((c) => !(c ?? expanded))}
        className="-mx-1.5 flex w-fit items-center gap-2 rounded-control px-1.5 py-1 transition-colors duration-100 hover:bg-hover-2"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill={working ? "var(--ink-2)" : "var(--ink-3)"}
        >
          <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
        </svg>
        {working ? (
          <ShimmerLabel>{activeLabel}</ShimmerLabel>
        ) : (
          <span
            className="text-[13px] font-medium whitespace-nowrap text-ink-2"
            style={{ animation: "fade-in 350ms ease-out both" }}
          >
            {doneLabel}
          </span>
        )}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--ink-3)"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transition-transform duration-300"
          style={{ transform: expanded ? "rotate(180deg)" : "rotate(0)" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-500"
        style={{
          gridTemplateRows: expanded ? "1fr" : "0fr",
          opacity: expanded ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
        }}
      >
        <div className="overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            <span
              aria-hidden
              className="absolute left-[3px] w-px bg-line-strong"
              style={{
                top: -8,
                height: lineHeight ? lineHeight - 2 : 0,
                transition: "height 500ms cubic-bezier(0.23,1,0.32,1)",
              }}
            />
            <div ref={traceRef} className="flex flex-col gap-0.5 py-1">
              {query && (
                <div className="flex h-6 items-center gap-2 px-1.5">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--ink-3)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    className="shrink-0"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="M21 21l-4.3-4.3" />
                  </svg>
                  <span className="text-[12.5px] text-ink-2">{query}</span>
                </div>
              )}
              {rows.slice(0, visible).map((row, i) => {
                const isLast = i === visible - 1;
                const spinning = working && isLast;
                const toneClass =
                  row.tone === "signal"
                    ? "text-signal"
                    : row.tone === "green"
                      ? "text-green"
                      : row.tone === "orange"
                        ? "text-orange"
                        : "text-ink";
                return (
                  <button
                    key={`${row.primary}-${i}`}
                    type="button"
                    onClick={() => onRowClick?.(row, i)}
                    className="flex min-h-7 w-full items-center gap-2 rounded-control px-1.5 py-0.5 text-left transition-colors duration-150 hover:bg-hover"
                    style={{
                      animation: `fade-up 320ms cubic-bezier(0.23,1,0.32,1) ${Math.min(i, 6) * 70}ms both`,
                    }}
                  >
                    {spinning ? (
                      <span
                        className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2"
                        style={{ animation: "spin 700ms linear infinite" }}
                      />
                    ) : (
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke={
                          row.tone === "signal"
                            ? "var(--signal)"
                            : row.tone === "green"
                              ? "var(--green)"
                              : "var(--ink-3)"
                        }
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                      >
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                    <span
                      className={`min-w-0 flex-1 truncate text-[12.5px] font-medium ${toneClass}`}
                    >
                      {row.primary}
                    </span>
                    {row.secondary && (
                      <span
                        className={`shrink-0 text-[11.5px] text-ink-3 ${row.mono ? "font-mono tabular-nums" : ""}`}
                      >
                        {row.secondary}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
