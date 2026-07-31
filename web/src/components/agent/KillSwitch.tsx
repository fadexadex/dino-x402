import { useState } from "react";
import { useVariant } from "@/lib/variants";

export function KillSwitch({ halted, onHalt, onResume }: { halted: boolean; onHalt: () => void; onResume?: () => void }) {
  const variant = useVariant("kill");
  const [confirming, setConfirming] = useState(false);

  const label = halted ? "Resume everything" : "Halt everything";

  const confirm = (
    <div className="absolute right-0 z-30 mt-2 w-64 rounded-lg border border-line bg-card p-3 shadow-lg">
      <p className="text-[12.5px] font-medium text-ink">Halt everything?</p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
        Stops the scheduler, voids pending proposals, and blocks autonomous execution across every
        portfolio. Already-submitted transactions cannot be recalled.
      </p>
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={() => {
            onHalt();
            setConfirming(false);
          }}
          className="flex-1 rounded-control bg-destructive px-2 py-1.5 text-[12px] font-medium text-destructive-foreground"
        >
          Halt
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="flex-1 rounded-control border border-line px-2 py-1.5 text-[12px] text-ink-2 hover:bg-hover"
        >
          Cancel
        </button>
      </div>
    </div>
  );

  if (variant === "Rail footer") {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => halted ? onResume?.() : setConfirming((c) => !c)}
          className={`w-full rounded-control border px-3 py-2 text-[12px] font-medium transition-colors ${
            halted
              ? "border-line bg-inset text-ink-3"
              : "border-destructive/30 text-destructive hover:bg-destructive/5"
          }`}
        >
          {label}
        </button>
        {confirming && confirm}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => halted ? onResume?.() : setConfirming((c) => !c)}
        className={`flex size-8 items-center justify-center rounded-control border transition-colors ${
          halted
            ? "border-line bg-inset text-ink-3"
            : "border-line text-destructive hover:border-destructive/40 hover:bg-destructive/5"
        }`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 3v10" />
          <path d="M6.4 6.4a8 8 0 1 0 11.2 0" />
        </svg>
      </button>
      {confirming && confirm}
    </div>
  );
}
