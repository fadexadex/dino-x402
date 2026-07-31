import type { AutonomyMode, Limits } from "@/lib/agent-types";
import { usd } from "@/lib/format";
import { useVariant } from "@/lib/variants";

export const MODES: { id: AutonomyMode; name: string; blurb: string }[] = [
  { id: 1, name: "Observe only", blurb: "Watches and reports. Never spends, never proposes." },
  { id: 2, name: "Advise only", blurb: "Buys intelligence, recommends. Takes no trading action." },
  { id: 3, name: "Propose and wait", blurb: "When you ask to trade (or bands drift), prepares a real swap and waits for your wallet approval." },
  { id: 4, name: "Autonomous within limits", blurb: "Executes from the agent treasury inside hard limits." },
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
        No execution without your wallet approval.
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

/**
 * Custody (wallet approval vs agent treasury) is set at onboarding.
 * Soft intensity 1–3 can still be adjusted when already on the wallet path;
 * Mode 4 requires a full re-onboard so the account/custody model stays coherent.
 */
export function AutonomyDial({
  mode,
  limits,
  custody,
  onChange,
  onLimitsChange,
}: {
  mode: AutonomyMode;
  limits: Limits;
  /** Which account model is active — drives whether Mode 4 is reachable in-chat. */
  custody?: "user_wallet" | "agent_managed";
  onChange: (m: AutonomyMode) => void;
  onLimitsChange?: (l: Limits) => void;
}) {
  const variant = useVariant("autonomy");
  const current = MODES.find((m) => m.id === mode)!;
  const walletPath = custody !== "agent_managed" && mode !== 4;
  const allowed = walletPath ? MODES.filter((m) => m.id <= 3) : MODES.filter((m) => m.id === 4);

  const changeSetup = (
    <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
      {walletPath
        ? "Approval custody is locked to your connected wallet. "
        : "Autonomous custody uses the agent treasury. "}
      <a href="/connect" className="animated-underline text-ink-2">
        Change setup
      </a>
      {" "}to switch between wallet approval and autonomous treasury.
    </p>
  );

  if (variant === "Vertical dial") {
    return (
      <div className="rounded-lg border border-line bg-card p-3">
        <p className="text-[10.5px] font-medium tracking-[0.09em] text-ink-3 uppercase">Autonomy</p>
        <div className="mt-2.5 flex gap-3">
          <div className="relative flex w-4 flex-col items-center justify-between py-1">
            <span aria-hidden className="absolute inset-y-1 w-px bg-line-strong" />
            {allowed.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-label={m.name}
                onClick={() => onChange(m.id)}
                disabled={!walletPath && m.id !== mode}
                className={`relative size-2.5 rounded-full border transition-colors ${
                  m.id === mode
                    ? "border-signal bg-signal"
                    : "border-line-strong bg-card hover:border-ink-3"
                }`}
              />
            ))}
          </div>
          <div className="flex flex-1 flex-col justify-between gap-1">
            {allowed.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onChange(m.id)}
                disabled={!walletPath && m.id !== mode}
                className={`text-left text-[12px] ${m.id === mode ? "font-medium text-ink" : "text-ink-3"}`}
              >
                {m.name}
              </button>
            ))}
          </div>
        </div>
        {changeSetup}
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
          {walletPath ? (
            <select
              value={mode}
              onChange={(e) => onChange(Number(e.target.value) as AutonomyMode)}
              className="rounded-control border border-line bg-card px-1.5 py-0.5 text-[11.5px] text-ink"
            >
              {allowed.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[11px] text-ink-3">Treasury</span>
          )}
        </div>
        <p className="mt-1.5 text-[12px] font-medium text-ink">{current.name}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">{current.blurb}</p>
        {changeSetup}
        <div className="mt-2.5 border-t border-line pt-2.5">
          <LimitList limits={limits} mode={mode} {...(onLimitsChange ? { onLimitsChange } : {})} />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <p className="text-[10.5px] font-medium tracking-[0.09em] text-ink-3 uppercase">Autonomy</p>
      <div className={`mt-2 grid gap-1 rounded-control bg-inset p-0.5 ${walletPath ? "grid-cols-3" : "grid-cols-1"}`}>
        {allowed.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onChange(m.id)}
            title={m.name}
            disabled={!walletPath && m.id !== mode}
            className={`rounded-[4px] py-1 font-mono text-[11.5px] transition-colors ${
              m.id === mode ? "bg-card text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {walletPath ? m.id : "Auto"}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[12px] font-medium text-ink">{current.name}</p>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">{current.blurb}</p>
      {changeSetup}
      <div className="mt-2.5 border-t border-line pt-2.5">
        <LimitList limits={limits} mode={mode} {...(onLimitsChange ? { onLimitsChange } : {})} />
      </div>
    </div>
  );
}
