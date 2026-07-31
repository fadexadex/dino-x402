import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Live sentence-by-sentence reasoning stream, adapted from samples/ThinkingReasoning.
 * New sentences fade/slide in one at a time; older lines stay put (no remount flicker).
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
  const [visibleCount, setVisibleCount] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const seenRef = useRef(0);

  const done = !working;
  const expanded = done ? open : true;

  const [frozenElapsed, setFrozenElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (done && frozenElapsed === null) {
      setFrozenElapsed(Math.max(1, Math.round((Date.now() - (startedAt ?? Date.now())) / 1000)));
    }
    if (!done && frozenElapsed !== null) setFrozenElapsed(null);
  }, [done, frozenElapsed, startedAt]);

  // Reveal newly arrived thoughts with a short stagger so motion stays soft.
  useEffect(() => {
    if (sentences.length <= seenRef.current) {
      setVisibleCount(sentences.length);
      return;
    }
    let cancelled = false;
    const reveal = () => {
      if (cancelled) return;
      setVisibleCount((count) => {
        if (count >= sentences.length) return count;
        return count + 1;
      });
    };
    // Show anything already buffered immediately, then ease in the rest.
    setVisibleCount((count) => Math.max(count, Math.min(sentences.length, seenRef.current || 1)));
    const id = window.setInterval(() => {
      setVisibleCount((count) => {
        if (count >= sentences.length) {
          window.clearInterval(id);
          return count;
        }
        return count + 1;
      });
    }, 140);
    reveal();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sentences.length]);

  useEffect(() => {
    seenRef.current = Math.max(seenRef.current, visibleCount);
  }, [visibleCount]);

  useEffect(() => {
    if (!working) {
      setVisibleCount(sentences.length);
      seenRef.current = sentences.length;
    }
  }, [working, sentences.length]);

  const displayElapsed = frozenElapsed
    ?? Math.max(1, Math.round((Date.now() - (startedAt ?? Date.now())) / 1000));
  const MAX_H = 200;
  const shown = sentences.slice(0, visibleCount);
  const [measuredH, setMeasuredH] = useState(0);
  useLayoutEffect(() => {
    setMeasuredH(streamRef.current?.scrollHeight ?? 0);
  }, [shown.length, expanded]);

  const height = measuredH;
  const capped = height > MAX_H;
  const viewH = capped ? MAX_H : Math.max(height, working ? 28 : 0);
  const scrollable = done && open;
  const FADE = 18;
  const translate = scrollable ? 0 : capped ? MAX_H - FADE - height : 0;
  const showTop = scrollable ? fade.top : capped;
  const showBottom = scrollable ? fade.bottom : capped;
  const mask = capped
    ? `linear-gradient(to bottom, transparent 0, #000 ${showTop ? FADE : 0}px, #000 calc(100% - ${showBottom ? FADE : 0}px), transparent 100%)`
    : "none";

  useEffect(() => {
    if (!working || !viewportRef.current) return;
    viewportRef.current.scrollTo({
      top: viewportRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [visibleCount, working]);

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
    <div className="flex w-full flex-col" style={{ animation: "fade-in 280ms cubic-bezier(0.22,1,0.36,1) both" }}>
      <button
        type="button"
        className={`inline-flex items-center gap-1.5 self-start rounded-control px-0.5 ${done ? "cursor-pointer hover:bg-hover-2" : "cursor-default"}`}
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
        className="grid transition-[grid-template-rows,opacity] duration-400"
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
              transition: "height 420ms cubic-bezier(0.22,1,0.36,1)",
            }}
            onScroll={scrollable ? onScroll : undefined}
          >
            <div
              ref={streamRef}
              className="flex flex-col gap-1.5"
              style={{
                transform: `translateY(${translate}px)`,
                transition: "transform 520ms cubic-bezier(0.22,1,0.36,1)",
              }}
            >
              {shown.map((line, i) => (
                <p
                  key={`thought-${i}`}
                  className="m-0 text-[13px] leading-[1.45] font-[425] tracking-[-0.005em] text-ink-2"
                  style={{
                    animation: i >= seenRef.current - 1
                      ? "fade-up 480ms cubic-bezier(0.22,1,0.36,1) both"
                      : undefined,
                  }}
                >
                  {line}
                </p>
              ))}
              {working && shown.length === 0 && (
                <p className="m-0 text-[13px] leading-5 text-ink-3" style={{ animation: "fade-in 300ms ease both" }}>
                  Gathering CoinGecko context…
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
