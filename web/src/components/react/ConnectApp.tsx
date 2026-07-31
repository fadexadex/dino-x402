import { useEffect, useState } from "react";
import { DinoMark } from "../agent/DinoMark";
import { api } from "../../lib/agent-api";
import { connectWallet, disconnectWallet, walletConfig } from "../../lib/wallet";

const WALLETS = ["HashPack", "Blade", "Kabila"] as const;

type Step = "path" | "connect" | "intensity" | "fund" | "done";
type CustodyPath = "approval" | "autonomous";
type WalletIntensity = 1 | 2 | 3;
type SessionRow = {
  id: string;
  name: string;
  kind: "user_wallet" | "agent_managed";
  accountId: string;
  status: string;
  autonomyMode: 1 | 2 | 3 | 4 | null;
};

const INTENSITY: Array<{ mode: WalletIntensity; title: string; detail: string }> = [
  {
    mode: 1,
    title: "Watch only",
    detail: "See live balances. No market-data spend and no trades.",
  },
  {
    mode: 2,
    title: "Advise me",
    detail: "Agent pays for CoinGecko prices and explains what it would do — nothing executes.",
  },
  {
    mode: 3,
    title: "Propose, I approve",
    detail: "Agent prepares each rebalance. Your connected wallet must approve before funds move.",
  },
];

/**
 * Custody is chosen at the door:
 * - Approval path → connect wallet → intensity 1–3
 * - Autonomous path → fund server treasury → Mode 4
 * Users can keep multiple wallet sessions and switch later from the workspace.
 */
export function ConnectApp() {
  const [step, setStep] = useState<Step>("path");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [path, setPath] = useState<CustodyPath | null>(null);
  const [agentAccountId, setAgentAccountId] = useState<string | null>(null);
  const [agentFunded, setAgentFunded] = useState(false);
  const [agentHbar, setAgentHbar] = useState(0);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const forceNew = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("new") === "1";

  useEffect(() => {
    void api.getOnboarding().then((state) => {
      if (state.agentTreasury) {
        setAgentAccountId(state.agentTreasury.accountId);
        setAgentFunded(state.agentTreasury.funded);
        setAgentHbar(state.agentTreasury.hbarFormatted);
      }
      if (state.connectedAccountId && !forceNew) {
        setAccountId(state.connectedAccountId);
      }
      setSessions(state.sessions ?? []);
      // Always land on the custody fork so users can change setup deliberately.
      setStep("path");
    }).catch(() => undefined);
  }, [forceNew]);

  const refreshTreasury = async () => {
    const state = await api.getOnboarding();
    if (state.agentTreasury) {
      setAgentAccountId(state.agentTreasury.accountId);
      setAgentFunded(state.agentTreasury.funded);
      setAgentHbar(state.agentTreasury.hbarFormatted);
    }
    setSessions(state.sessions ?? []);
    return state.agentTreasury;
  };

  const chooseApprovalPath = () => {
    setError(null);
    setPath("approval");
    setStep(accountId && !forceNew ? "intensity" : "connect");
  };

  const chooseAutonomousPath = async () => {
    setBusy(true);
    setError(null);
    setPath("autonomous");
    try {
      const treasury = await refreshTreasury();
      if (!treasury?.accountId) {
        setError("Autonomous mode needs a configured agent treasury account on the server.");
        setPath(null);
        return;
      }
      setStep("fund");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load agent treasury.");
      setPath(null);
    } finally {
      setBusy(false);
    }
  };

  const onConnect = async (force = forceNew || Boolean(accountId)) => {
    if (!walletConfig.enabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      const connected = await connectWallet({ force });
      await api.connectAccount(connected, `Wallet ${connected}`);
      setAccountId(connected);
      await refreshTreasury();
      setStep("intensity");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connection failed.");
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.disconnectAccount();
      await disconnectWallet();
      setAccountId(null);
      await refreshTreasury();
      setStep("path");
      setPath(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  };

  const onResumeSession = async (sessionId: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.activateProfile(sessionId);
      const activated = result.profile;
      if (activated.kind === "user_wallet" && activated.accountId && walletConfig.enabled) {
        const connected = await connectWallet({ force: true });
        if (connected !== activated.accountId) {
          throw new Error(`Connect wallet ${activated.accountId} to resume that session (got ${connected}).`);
        }
      }
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resume that session.");
    } finally {
      setBusy(false);
    }
  };

  const onChooseIntensity = async (mode: WalletIntensity) => {
    setBusy(true);
    setError(null);
    try {
      await api.completeOnboarding(mode);
      setStep("done");
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your choice.");
    } finally {
      setBusy(false);
    }
  };

  const onEnableAutonomous = async () => {
    setBusy(true);
    setError(null);
    try {
      const treasury = await refreshTreasury();
      if (!treasury?.funded) {
        setError("Transfer testnet HBAR (and any tokens you want managed) into the agent treasury, then check again.");
        return;
      }
      await api.completeOnboarding(4);
      setStep("done");
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not enable autonomous mode.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-4 py-10">
      <div className="w-full max-w-md">
        <span className="flex items-center gap-2 text-ink">
          <DinoMark size={26} />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Dino Agent</span>
        </span>

        {step === "path" && (
          <>
            <h1 className="mt-6 text-[22px] leading-tight font-semibold tracking-[-0.02em] text-ink">
              {forceNew ? "Start a new session" : "How should money move?"}
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              {forceNew
                ? "Connect a different wallet or enable the autonomous treasury. Existing sessions stay saved so you can switch back later."
                : "Pick custody for this session. You can disconnect, add another wallet, or switch sessions any time from the workspace."}
            </p>

            {sessions.length > 0 && (
              <div className="mt-5 rounded-lg border border-line bg-card p-3">
                <p className="text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">Saved sessions</p>
                <div className="mt-2 grid gap-1">
                  {sessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      disabled={busy}
                      onClick={() => void onResumeSession(session.id)}
                      className="flex items-center justify-between rounded-md px-2 py-2 text-left transition-colors hover:bg-hover disabled:opacity-50"
                    >
                      <span>
                        <span className="block font-mono text-[12px] text-ink">{session.accountId}</span>
                        <span className="mt-0.5 block text-[11px] text-ink-3">
                          {session.kind === "agent_managed" ? "autonomous" : "wallet"} · {session.status}
                        </span>
                      </span>
                      <span className="text-[11px] text-ink-2">Resume</span>
                    </button>
                  ))}
                </div>
                {accountId && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onDisconnect()}
                    className="mt-2 rounded-control px-2 py-1.5 text-[12px] text-ink-3 hover:bg-hover"
                  >
                    Disconnect current wallet
                  </button>
                )}
              </div>
            )}

            <div className="mt-6 grid gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={chooseApprovalPath}
                className="rounded-lg border border-line bg-card px-3.5 py-3 text-left transition-colors hover:bg-hover disabled:opacity-50"
              >
                <span className="text-[13px] font-medium text-ink">
                  {forceNew || accountId ? "Connect a wallet for this session" : "I approve each trade"}
                </span>
                <span className="mt-1 block text-[12px] leading-relaxed text-ink-2">
                  Connect your Hedera wallet. The agent may prepare swaps; nothing leaves your account until you confirm in the wallet app.
                </span>
              </button>
              <button
                type="button"
                disabled={busy || !agentAccountId}
                onClick={() => void chooseAutonomousPath()}
                className="rounded-lg border border-line bg-card px-3.5 py-3 text-left transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="text-[13px] font-medium text-ink">Let the agent run on its own</span>
                <span className="mt-1 block text-[12px] leading-relaxed text-ink-2">
                  Fund a server-managed treasury{agentAccountId ? ` (${agentAccountId})` : ""}. No WalletConnect required — trades execute within your limits.
                </span>
              </button>
            </div>
          </>
        )}

        {step === "connect" && (
          <>
            <h1 className="mt-6 text-[22px] leading-tight font-semibold tracking-[-0.02em] text-ink">
              Connect your wallet
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              Approval-gated mode uses the account you connect here. You can disconnect later and connect a different wallet as another session.
            </p>
            <div className="mt-6 grid gap-2">
              {WALLETS.map((wallet) => (
                <button
                  key={wallet}
                  type="button"
                  disabled={!walletConfig.enabled || busy}
                  onClick={() => void onConnect(true)}
                  className="flex items-center justify-between rounded-lg border border-line bg-card px-3.5 py-3 text-left transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="text-[13px] font-medium text-ink">{wallet}</span>
                  <span className="font-mono text-[11px] text-ink-3">{busy ? "…" : "testnet"}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setPath(null); setStep("path"); }}
              className="mt-3 rounded-control px-3 py-1.5 text-[12.5px] text-ink-3"
            >
              Back
            </button>
          </>
        )}

        {step === "intensity" && (
          <>
            <h1 className="mt-6 text-[22px] leading-tight font-semibold tracking-[-0.02em] text-ink">
              How hands-on should it be?
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              Connected as <span className="font-mono text-ink">{accountId}</span>. Funds stay in your wallet unless you approve a trade.
            </p>
            <div className="mt-6 grid gap-2">
              {INTENSITY.map((item) => (
                <button
                  key={item.mode}
                  type="button"
                  disabled={busy}
                  onClick={() => void onChooseIntensity(item.mode)}
                  className="rounded-lg border border-line bg-card px-3.5 py-3 text-left transition-colors hover:bg-hover disabled:opacity-50"
                >
                  <span className="text-[13px] font-medium text-ink">{item.title}</span>
                  <span className="mt-1 block text-[12px] leading-relaxed text-ink-2">{item.detail}</span>
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setStep("connect")}
                className="rounded-control px-3 py-1.5 text-[12.5px] text-ink-3"
              >
                Use a different wallet
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setStep(accountId ? "path" : "connect")}
                className="rounded-control px-3 py-1.5 text-[12.5px] text-ink-3"
              >
                Back
              </button>
            </div>
          </>
        )}

        {step === "fund" && (
          <>
            <h1 className="mt-6 text-[22px] leading-tight font-semibold tracking-[-0.02em] text-ink">
              Fund the agent treasury
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              Only assets you send here can be traded without asking you each time. Transfer testnet HBAR (and USDC/SAUCE if you want them managed), then continue.
            </p>
            <div className="mt-6 rounded-lg border border-line bg-card px-3.5 py-3">
              <p className="text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">Agent treasury</p>
              <p className="mt-1 break-all font-mono text-[13px] text-ink">{agentAccountId ?? "—"}</p>
              <p className="mt-2 text-[12px] text-ink-2">
                Balance: <span className="font-mono text-ink">{agentHbar.toFixed(4)} ℏ</span>
                {agentFunded ? " · ready" : " · waiting for funds"}
              </p>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void refreshTreasury().catch((err) => setError(err instanceof Error ? err.message : "Refresh failed"))}
                className="rounded-control border border-line px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-hover"
              >
                Check balance
              </button>
              <button
                type="button"
                disabled={busy || !agentFunded}
                onClick={() => void onEnableAutonomous()}
                className="rounded-control bg-ink px-3 py-1.5 text-[12.5px] font-medium text-background disabled:opacity-40"
              >
                Enable autonomous mode
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => { setPath(null); setStep("path"); }}
                className="rounded-control px-3 py-1.5 text-[12.5px] text-ink-3"
              >
                Back
              </button>
            </div>
          </>
        )}

        {step === "done" && (
          <div className="mt-6 rounded-lg border border-line bg-card px-3.5 py-3">
            <p className="text-[13px] text-ink">Setup complete. Opening workspace…</p>
            <a href="/" className="mt-3 inline-flex text-[12.5px] text-ink-2">Open workspace →</a>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 text-[11px] leading-relaxed text-orange">
            {error}
          </p>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-ink-2">
          {path === "approval" || step === "connect" || step === "intensity"
            ? walletConfig.enabled
              ? "WalletConnect is ready for Hedera testnet. HashPack and Kabila appear in the QR / extension modal."
              : "WalletConnect is not enabled. Set PUBLIC_REOWN_PROJECT_ID to connect a wallet."
            : "Autonomous mode does not need WalletConnect — it uses the funded agent treasury on the server."}
        </p>
        <a href="/" className="animated-underline mt-4 inline-block text-[12.5px] text-ink-2">
          Return to workspace →
        </a>
      </div>
    </main>
  );
}
