import type { AutonomyMode, Limits } from "@/lib/agent-types";
import { usd } from "@/lib/format";
import { useVariant } from "@/lib/variants";

export const MODES: { id: AutonomyMode; name: string; blurb: string }[] = [
  { id: 1, name: "Observe only", blurb: "Watches and reports. Never spends, never proposes." },
  { id: 2, name: "Advise only", blurb: "Buys intelligence, recommends. Takes no trading action." },
  { id: 3, name: "Propose and wait", blurb: "Constructs exact trades, waits for your approval." },
  { id: 4, name: "Autonomous within limits", blurb: "Executes inside hard limits; anything over falls back to propose-and-wait." },
];

function NumField({
  label,
  value,
  prefix,
  suffix,
  step = 1,
  min = 0,
  onChange,
}: {
  label: string;
  value: number;
  prefix?: string;
  suffix?: string;
  step?: number;
  min?: number;
  onChange?: (v: number) => void;
}) {
  return (
    <label className="flex items-baseline justify-between gap-3 text-[11.5px]">
      <span className="text-ink-3">{label}</span>
      {onChange ? (
        <span className="flex items-baseline gap-0.5 rounded-control border border-line bg-inset px-1.5 py-0.5 focus-within:border-signal">
          {prefix && <span className="font-mono text-[11px] text-ink-3">{prefix}</span>}
          <input
            type="number"
            min={min}
            step={step}
            value={value}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isNaN(n)) onChange(Math.max(min, n));
            }}
            className="w-14 bg-transparent text-right font-mono text-[11.5px] text-ink tabular-nums outline-none"
          />
          {suffix && <span className="font-mono text-[11px] text-ink-3">{suffix}</span>}
        </span>
      ) : (
        <span className="font-mono text-[11.5px] text-ink tabular-nums">
          {prefix}
          {value}
          {suffix}
        </span>
      )}
    </label>
  );
}

function LimitList({
  limits,
  mode,
  onLimitsChange,
}: {
  limits: Limits;
  mode: AutonomyMode;
  onLimitsChange?: (l: Limits) => void;
}) {
  if (mode < 4)
    return (
      <p className="text-[11.5px] leading-relaxed text-ink-3">
        No execution limits apply — nothing executes without you.
        {mode >= 2 && ` Daily data budget ${usd(limits.maxDailySpend)}.`}
      </p>
    );
  const patch = (p: Partial<Limits>) => onLimitsChange?.({ ...limits, ...p });
  return (
    <div className="grid gap-1.5">
      <NumField
        label="Max per trade"
        value={limits.maxPerTrade}
        prefix="$"
        step={25}
        min={10}
        {...(onLimitsChange ? { onChange: (v: number) => patch({ maxPerTrade: v }) } : {})}
      />
      <NumField
        label="Max trades / day"
        value={limits.maxTradesPerDay}
        min={1}
        {...(onLimitsChange ? { onChange: (v: number) => patch({ maxTradesPerDay: v }) } : {})}
      />
      <NumField
        label="Max portfolio move"
        value={limits.maxPortfolioMovePct}
        suffix="%"
        min={1}
        {...(onLimitsChange ? { onChange: (v: number) => patch({ maxPortfolioMovePct: v }) } : {})}
      />
      <NumField
        label="Max data spend / day"
        value={limits.maxDailySpend}
        prefix="$"
        step={0.5}
        {...(onLimitsChange ? { onChange: (v: number) => patch({ maxDailySpend: v }) } : {})}
      />
      <div className="flex items-baseline justify-between gap-3 text-[11.5px]">
        <span className="text-ink-3">Allow-list</span>
        <span className="font-mono text-[11.5px] text-ink">{limits.allowList.join(" · ")}</span>
      </div>
      {onLimitsChange && (
        <p className="text-[10.5px] leading-relaxed text-ink-3">
          Anything above these caps falls back to propose-and-wait.
        </p>
      )}
    </div>
  );
}


export function AutonomyDial({
  mode,
  limits,
  onChange,
  onLimitsChange,
}: {
  mode: AutonomyMode;
  limits: Limits;
  onChange: (m: AutonomyMode) => void;
  onLimitsChange?: (l: Limits) => void;
}) {
  const variant = useVariant("autonomy");
  const current = MODES.find((m) => m.id === mode)!;

  if (variant === "Vertical dial") {
    return (
      <div className="rounded-lg border border-line bg-card p-3">
        <p className="text-[10.5px] font-medium tracking-[0.09em] text-ink-3 uppercase">Autonomy</p>
        <div className="mt-2.5 flex gap-3">
          <div className="relative flex w-4 flex-col items-center justify-between py-1">
            <span aria-hidden className="absolute inset-y-1 w-px bg-line-strong" />
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-label={m.name}
                onClick={() => onChange(m.id)}
                className={`relative size-2.5 rounded-full border transition-colors ${
                  m.id === mode
                    ? "border-signal bg-signal"
                    : "border-line-strong bg-card hover:border-ink-3"
                }`}
              />
            ))}
          </div>
          <div className="flex flex-1 flex-col justify-between gap-1">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onChange(m.id)}
                className={`text-left text-[12px] ${m.id === mode ? "font-medium text-ink" : "text-ink-3"}`}
              >
                {m.name}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 border-t border-line pt-2.5">
          <LimitList limits={limits} mode={mode} {...(onLimitsChange ? { onLimitsChange } : {})} />
        </div>
      </div>
    );
  }

  if (variant === "Limits card") {
    return (
      <div className="rounded-lg border border-line bg-card p-3">
        <div className="flex items-baseline justify-between">
          <p className="text-[10.5px] font-medium tracking-[0.09em] text-ink-3 uppercase">
            Mode {mode}
          </p>
          <select
            value={mode}
            onChange={(e) => onChange(Number(e.target.value) as AutonomyMode)}
            className="rounded-control border border-line bg-card px-1.5 py-0.5 text-[11.5px] text-ink"
          >
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1.5 text-[12px] font-medium text-ink">{current.name}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">{current.blurb}</p>
        <div className="mt-2.5 border-t border-line pt-2.5">
          <LimitList limits={limits} mode={mode} {...(onLimitsChange ? { onLimitsChange } : {})} />
        </div>
      </div>
    );
  }

  // Segmented
  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <p className="text-[10.5px] font-medium tracking-[0.09em] text-ink-3 uppercase">Autonomy</p>
      <div className="mt-2 grid grid-cols-4 gap-1 rounded-control bg-inset p-0.5">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onChange(m.id)}
            title={m.name}
            className={`rounded-[4px] py-1 font-mono text-[11.5px] transition-colors ${
              m.id === mode ? "bg-card text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {m.id}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[12px] font-medium text-ink">{current.name}</p>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">{current.blurb}</p>
      <div className="mt-2.5 border-t border-line pt-2.5">
        <LimitList limits={limits} mode={mode} {...(onLimitsChange ? { onLimitsChange } : {})} />
      </div>
    </div>
  );
}
