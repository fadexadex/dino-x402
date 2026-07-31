import { useEffect, useState } from "react";
import { clock } from "@/lib/format";
import { useVariant } from "@/lib/variants";

export const CADENCES: { label: string; ms: number }[] = [
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 5 * 60_000 },
  { label: "15m", ms: 15 * 60_000 },
  { label: "30m", ms: 30 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "4h", ms: 4 * 60 * 60_000 },
];

function CadencePicker({
  cadenceMs,
  onCadenceChange,
  className = "",
}: {
  cadenceMs: number;
  onCadenceChange: (ms: number) => void;
  className?: string;
}) {
  return (
    <label className={`flex items-center gap-1 text-[11px] text-ink-3 ${className}`}>
      <span className="sr-only">Agent run frequency</span>
      <select
        value={cadenceMs}
        onChange={(e) => onCadenceChange(Number(e.target.value))}
        title="How often the agent runs a check-in"
        className="rounded-control border border-line bg-card px-1.5 py-0.5 font-mono text-[11px] text-ink-2 outline-none focus:border-signal"
      >
        {CADENCES.map((c) => (
          <option key={c.ms} value={c.ms}>
            every {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function WatchStatus({
  lastCheckIn,
  cadenceMs,
  paused,
  onTogglePause,
  onCadenceChange,
}: {
  lastCheckIn: number;
  cadenceMs: number;
  paused: boolean;
  onTogglePause: () => void;
  onCadenceChange?: (ms: number) => void;
}) {
  const variant = useVariant("watch");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const next = lastCheckIn + cadenceMs;
  const leftMs = Math.max(0, next - now);
  const mins = Math.floor(leftMs / 60000);
  const secs = Math.floor((leftMs % 60000) / 1000);
  const nextIn = paused ? "paused" : `${mins}m ${String(secs).padStart(2, "0")}s`;

  if (variant === "Rail block") {
    return (
      <div className="rounded-lg border border-line bg-card p-3">
        <div className="flex items-center gap-2">
          <span
            className={`size-1.5 rounded-full ${paused ? "bg-ink-3" : "bg-green"}`}
            style={paused ? undefined : { animation: "pulse-ring 2.4s ease-out infinite" }}
          />
          <p className="text-[10.5px] font-medium tracking-[0.09em] text-ink-3 uppercase">
            {paused ? "Watch paused" : "Watching"}
          </p>
        </div>
        <dl className="mt-2 grid gap-1 text-[11.5px]">
          <div className="flex justify-between">
            <dt className="text-ink-3">Last check-in</dt>
            <dd className="font-mono text-ink tabular-nums">{clock(lastCheckIn)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-3">Next in</dt>
            <dd className="font-mono text-ink tabular-nums">{nextIn}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-3">Runs</dt>
            <dd>
              {onCadenceChange ? (
                <CadencePicker cadenceMs={cadenceMs} onCadenceChange={onCadenceChange} />
              ) : (
                <span className="font-mono text-ink tabular-nums">
                  every {CADENCES.find((c) => c.ms === cadenceMs)?.label ?? "15m"}
                </span>
              )}
            </dd>
          </div>
        </dl>
        <button
          type="button"
          onClick={onTogglePause}
          className="mt-2.5 w-full rounded-control border border-line py-1.5 text-[11.5px] font-medium text-ink-2 transition-colors hover:bg-hover"
        >
          {paused ? "Resume watching" : "Pause watching"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
    <button
      type="button"
      onClick={onTogglePause}
      className="flex items-center gap-2 rounded-full border border-line bg-card px-2.5 py-1 transition-colors hover:bg-hover"
    >
      <span
        className={`size-1.5 rounded-full ${paused ? "bg-ink-3" : "bg-green"}`}
        style={paused ? undefined : { animation: "pulse-ring 2.4s ease-out infinite" }}
      />
      <span className="text-[11.5px] text-ink-2">
        {paused ? "Paused" : "Watching"} · next{" "}
        <span className="font-mono text-ink tabular-nums">{nextIn}</span>
      </span>
    </button>
      {onCadenceChange && (
        <CadencePicker cadenceMs={cadenceMs} onCadenceChange={onCadenceChange} />
      )}
    </div>
  );
}
