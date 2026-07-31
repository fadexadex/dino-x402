import { clock } from "@/lib/format";

/** Distinct "you said" bubble so composer text stays visible in the stream. */
export function UserMessage({
  text,
  at,
}: {
  text: string;
  at: number;
}) {
  return (
    <div
      className="flex justify-end"
      style={{ animation: "fade-up 280ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-3.5 py-2.5 text-background">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[10.5px] font-medium tracking-[0.08em] text-background/60 uppercase">
            You
          </span>
          <span className="font-mono text-[10.5px] text-background/50 tabular-nums">
            {clock(at)}
          </span>
        </div>
        <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap">{text}</p>
      </div>
    </div>
  );
}
