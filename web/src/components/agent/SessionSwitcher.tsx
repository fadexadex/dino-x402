import { useEffect, useRef, useState } from "react";
import type { PortfolioProfile } from "../../lib/agent-api";

type Props = {
  profiles: PortfolioProfile[];
  activeProfileId?: string | null;
  connected: boolean;
  busy?: boolean;
  onActivate: (profileId: string) => void | Promise<void>;
  onDisconnect: () => void | Promise<void>;
  onNewSession: () => void;
  onClearSession?: (profileId: string) => void | Promise<void>;
  onRemoveSession?: (profileId: string) => void | Promise<void>;
};

function labelFor(profile: PortfolioProfile): string {
  if (profile.kind === "agent_managed") return `Agent · ${profile.accountId ?? "treasury"}`;
  return profile.accountId ?? profile.name;
}

function kindLabel(profile: PortfolioProfile): string {
  return profile.kind === "agent_managed" ? "autonomous" : "wallet";
}

/**
 * Header control for switching between saved wallet / agent sessions,
 * disconnecting the live wallet, or starting a fresh onboarding path.
 */
export function SessionSwitcher({
  profiles,
  activeProfileId,
  connected,
  busy = false,
  onActivate,
  onDisconnect,
  onNewSession,
  onClearSession,
  onRemoveSession,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const sessions = profiles.filter((profile) => profile.id !== "connected-wallet");
  const active = sessions.find((profile) => profile.id === activeProfileId) ?? sessions.find((profile) => profile.status === "active");

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 font-mono text-[11px] text-ink-3 transition-colors hover:bg-hover disabled:opacity-50"
      >
        <span className={`size-1.5 rounded-full ${connected ? "bg-green" : "bg-ink-3"}`} />
        {connected && active
          ? `${active.accountId} · ${active.network ?? "testnet"}`
          : sessions.length
            ? "choose session"
            : "connect wallet"}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-[calc(100%+6px)] left-0 z-40 flex max-h-[min(28rem,70vh)] w-[min(22rem,calc(100vw-2rem))] flex-col rounded-lg border border-line bg-card p-1.5 shadow-sm"
        >
          <p className="shrink-0 px-2 py-1 text-[10.5px] font-medium tracking-[0.08em] text-ink-3 uppercase">
            Sessions
          </p>
          {sessions.length === 0 && (
            <p className="px-2 py-2 text-[12px] text-ink-2">No saved sessions yet.</p>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5 [scrollbar-width:thin]">
            <div className="grid gap-0.5">
              {sessions.map((profile) => {
                const isActive = profile.id === active?.id;
                return (
                  <div
                    key={profile.id}
                    className={`flex items-stretch gap-1 rounded-md ${isActive ? "bg-hover" : ""}`}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy || isActive}
                      onClick={() => {
                        setOpen(false);
                        void onActivate(profile.id);
                      }}
                      className="min-w-0 flex-1 px-2 py-2 text-left transition-colors hover:bg-hover disabled:opacity-100"
                    >
                      <span className="block font-mono text-[11.5px] text-ink">{labelFor(profile)}</span>
                      <span className="mt-0.5 block text-[11px] text-ink-3">
                        {kindLabel(profile)} · {profile.status ?? "paused"}
                        {profile.autonomyMode ? ` · mode ${profile.autonomyMode}` : ""}
                      </span>
                    </button>
                    <div className="flex shrink-0 flex-col justify-center gap-0.5 py-1 pr-1">
                      {isActive && (
                        <span className="px-1 text-[10px] font-medium tracking-[0.06em] text-green uppercase">
                          active
                        </span>
                      )}
                      {isActive && onClearSession && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpen(false);
                            void onClearSession(profile.id);
                          }}
                          className="rounded px-1.5 py-0.5 text-[10.5px] text-ink-3 hover:bg-card hover:text-ink"
                          title="Clear runs and messages for this session"
                        >
                          Clear
                        </button>
                      )}
                      {!isActive && onRemoveSession && profile.kind === "user_wallet" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpen(false);
                            void onRemoveSession(profile.id);
                          }}
                          className="rounded px-1.5 py-0.5 text-[10.5px] text-ink-3 hover:bg-card hover:text-orange"
                          title="Remove this paused session"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="mt-1 grid shrink-0 gap-0.5 border-t border-line pt-1">
            {active && onClearSession && (
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  void onClearSession(active.id);
                }}
                className="rounded-md px-2 py-2 text-left text-[12.5px] text-ink transition-colors hover:bg-hover"
              >
                Clear active session…
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onNewSession();
              }}
              className="rounded-md px-2 py-2 text-left text-[12.5px] text-ink transition-colors hover:bg-hover"
            >
              New session…
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={busy || !connected}
              onClick={() => {
                setOpen(false);
                void onDisconnect();
              }}
              className="rounded-md px-2 py-2 text-left text-[12.5px] text-ink-2 transition-colors hover:bg-hover disabled:opacity-40"
            >
              Disconnect wallet
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
