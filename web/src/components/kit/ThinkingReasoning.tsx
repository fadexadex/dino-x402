import { useEffect, useRef, useState } from "react";

/**
 * Live sentence-by-sentence reasoning stream, adapted from samples/ThinkingReasoning.
 * Accepts real agent thoughts instead of a hardcoded demo script.
 */
export function ThinkingReasoning({
  sentences,
  working,
  startedAt,
}: {
  sentences: string[];
  working: boolean;
  startedAt?: number;
}) {
  const [open, setOpen] = useState(false);
  const [fade, setFade] = useState({ top: false, bottom: true });
  const viewportRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  const done = !working;
  const expanded = done ? open : true;
  const elapsedS = Math.max(
    1,
    Math.round(((done ? Date.now() : Date.now()) - (startedAt ?? Date.now())) / 1000),
  );
  // Freeze elapsed once done by using a stable snapshot from startedAt → now at first done paint.
  const [frozenElapsed, setFrozenElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (done && frozenElapsed === null) {
      setFrozenElapsed(Math.max(1, Math.round((Date.now() - (startedAt ?? Date.now())) / 1000)));
    }
    if (!done && frozenElapsed !== null) setFrozenElapsed(null);
  }, [done, frozenElapsed, startedAt]);

  const displayElapsed = frozenElapsed ?? elapsedS;
  const MAX_H = 180;
  const contentH = streamRef.current?.scrollHeight ?? Math.min(sentences.length * 44, MAX_H);
  const [measuredH, setMeasuredH] = useState(0);
  useEffect(() => {
    setMeasuredH(streamRef.current?.scrollHeight ?? 0);
  }, [sentences.length, expanded]);

  const height = measuredH || contentH;
  const capped = height > MAX_H;
  const viewH = capped ? MAX_H : height;
  const scrollable = done && open;
  const FADE = 16;
  const translate = scrollable ? 0 : capped ? MAX_H - FADE - height : 0;
  const showTop = scrollable ? fade.top : capped;
  const showBottom = scrollable ? fade.bottom : capped;
  const mask = capped
    ? `linear-gradient(to bottom, transparent 0, #000 ${showTop ? FADE : 0}px, #000 calc(100% - ${showBottom ? FADE : 0}px), transparent 100%)`
    : "none";

  useEffect(() => {
    if (working && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [sentences.length, working]);

  const onScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    setFade({
      top: el.scrollTop > 1,
      bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    });
  };

  if (sentences.length === 0 && !working) return null;

  return (
    <div className="flex w-full flex-col" style={{ animation: "fade-in 320ms cubic-bezier(0.22,1,0.36,1) both" }}>
      <button
        type="button"
        className={`inline-flex items-center gap-1.5 self-start ${done ? "cursor-pointer" : "cursor-default"}`}
        aria-expanded={expanded}
        aria-label="Toggle thought"
        onClick={done ? () => {
          const next = !open;
          if (next) {
            setFade({ top: false, bottom: true });
            if (viewportRef.current) viewportRef.current.scrollTop = 0;
          }
          setOpen(next);
        } : undefined}
      >
        {done ? (
          <span className="text-[13px] font-medium tracking-[-0.005em] text-ink-3">
            <span className="text-ink-2">Thought</span> for {displayElapsed}s
          </span>
        ) : (
          <span
            className="bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent"
            style={{
              backgroundImage:
                "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
              backgroundSize: "200% 100%",
              animation: "shimmer-text 1.4s linear infinite",
            }}
          >
            Thinking…
          </span>
        )}
        {done && (
          <svg
            className="text-ink-3 transition-transform duration-300"
            style={{ transform: expanded ? "rotate(0deg)" : "rotate(180deg)" }}
            viewBox="0 0 24 24"
            width="12"
            height="12"
            aria-hidden="true"
          >
            <path
              d="m4.5 15.75 7.5-7.5 7.5 7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: expanded ? "1fr" : "0fr",
          opacity: expanded ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            ref={viewportRef}
            className={`mt-1.5 overflow-hidden ${scrollable ? "overflow-y-auto [scrollbar-width:none]" : ""}`}
            style={{
              height: `${viewH}px`,
              WebkitMaskImage: mask,
              maskImage: mask,
              transition: "height 360ms cubic-bezier(0.22,1,0.36,1)",
            }}
            onScroll={scrollable ? onScroll : undefined}
          >
            <div
              ref={streamRef}
              className="flex flex-col gap-1"
              style={{
                transform: `translateY(${translate}px)`,
                transition: "transform 560ms cubic-bezier(0.22,1,0.36,1)",
              }}
            >
              {sentences.map((line, i) => (
                <p
                  key={`${i}-${line.slice(0, 24)}`}
                  className="m-0 text-[13px] leading-5 font-[425] tracking-[-0.005em] text-ink-2"
                  style={{ animation: "fade-up 420ms cubic-bezier(0.22,1,0.36,1) both" }}
                >
                  {line}
                </p>
              ))}
              {working && sentences.length === 0 && (
                <p className="m-0 text-[13px] leading-5 text-ink-3">Gathering context…</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
