// Ported from the provided sample kit (pixel-grid wavefront loader),
// rewired onto the Dino Agent design tokens.
import { useEffect, useState } from "react";

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3),
    c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS: Record<
  string,
  { delays: (number | null)[]; dur: number; round: boolean }
> = {
  Drive: { delays: chevron, dur: 650, round: false },
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false },
};

function useElapsed(startedAt?: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  const total = Math.max(0, (now - (startedAt ?? now)) / 1000);
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

export function LoadingState({
  label = "Working",
  variant = "Drive",
  startedAt,
  tone = "ink",
}: {
  label?: string;
  variant?: string;
  startedAt?: number;
  tone?: "ink" | "signal";
}) {
  const elapsed = useElapsed(startedAt);
  const { delays, dur, round } = PATTERNS[variant] ?? PATTERNS["Drive"]!;
  const cell = tone === "signal" ? "bg-signal" : "bg-ink";

  return (
    <div className="flex w-fit items-center gap-2.5">
      <span aria-hidden className="grid grid-cols-[repeat(3,4px)] gap-[1.5px]">
        {delays.map((d, i) => (
          <span
            key={i}
            className={`size-[4px] ${cell} ${round ? "rounded-full" : "rounded-[1px]"}`}
            style={{
              opacity: d === null ? 0.07 : 0.15,
              animation:
                d === null ? "none" : `pixel-on ${dur}ms ease-in-out ${d}ms infinite`,
            }}
          />
        ))}
      </span>
      <ShimmerLabel>{label}</ShimmerLabel>
      <span className="font-mono text-[12px] text-ink-3 tabular-nums">{elapsed}</span>
    </div>
  );
}

export function ShimmerLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent"
      style={{
        backgroundImage:
          "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
        backgroundSize: "200% 100%",
        animation: "shimmer-text 1.4s linear infinite",
      }}
    >
      {children}
    </span>
  );
}
