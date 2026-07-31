import type { AgentEvent } from "@/lib/agent-types";
import { clock } from "@/lib/format";

/** End-of-run summary so the stream closes with a clear outcome. */
export function ConclusionCard({
  event,
  bullets = [],
}: {
  event: AgentEvent;
  bullets?: string[];
}) {
  const tone =
    event.tone === "orange"
      ? "border-orange/30 bg-orange-soft/40"
      : event.tone === "green"
        ? "border-green/30 bg-green-soft/50"
        : "border-signal/30 bg-signal-soft/40";

  return (
    <article
      className={`rounded-lg border px-3.5 py-3 ${tone}`}
      style={{ animation: "fade-up 360ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[10.5px] font-medium tracking-[0.09em] text-ink-3 uppercase">
          Conclusion
        </span>
        <span className="ml-auto font-mono text-[11px] text-ink-3 tabular-nums">
          {clock(event.at)}
        </span>
      </div>
      <p className="mt-1.5 text-[14px] leading-snug font-medium text-ink">
        {event.detail || event.title}
      </p>
      {bullets.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {bullets.map((bullet) => (
            <li key={bullet} className="flex gap-2 text-[12.5px] leading-relaxed text-ink-2">
              <span className="mt-[0.55em] size-1 shrink-0 rounded-full bg-ink-3" aria-hidden />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
