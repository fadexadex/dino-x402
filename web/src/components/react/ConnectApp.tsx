import { useEffect, useState } from "react";
import { DinoMark } from "../agent/DinoMark";
import { api } from "../../lib/agent-api";
import { connectWallet, walletConfig } from "../../lib/wallet";

const WALLETS = ["HashPack", "Blade", "Kabila"] as const;

type Step = "path" | "connect" | "intensity" | "fund" | "done";
type CustodyPath = "approval" | "autonomous";
type WalletIntensity = 1 | 2 | 3;

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
 * Custody is chosen once at the door:
 * - Approval path → connect wallet → intensity 1–3
 * - Autonomous path → fund server treasury → Mode 4
 * Switching custody later is a re-onboard, not a mid-chat dial flip.
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

  useEffect(() => {
    void api.getOnboarding().then((state) => {
      if (state.agentTreasury) {
        setAgentAccountId(state.agentTreasury.accountId);
        setAgentFunded(state.agentTreasury.funded);
        setAgentHbar(state.agentTreasury.hbarFormatted);
      }
      if (state.connectedAccountId) {
        setAccountId(state.connectedAccountId);
      }
      // Always land on the custody fork so users can change setup deliberately.
      // Prior completion is remembered only as account/treasury context.
      setStep("path");
    }).catch(() => undefined);
  }, []);

  const refreshTreasury = async () => {
    const state = await api.getOnboarding();
    if (state.agentTreasury) {
      setAgentAccountId(state.agentTreasury.accountId);
      setAgentFunded(state.agentTreasury.funded);
      setAgentHbar(state.agentTreasury.hbarFormatted);
    }
    return state.agentTreasury;
  };

  const chooseApprovalPath = () => {
    setError(null);
    setPath("approval");
    setStep(accountId ? "intensity" : "connect");
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

  const onConnect = async () => {
    if (!walletConfig.enabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      const connected = await connectWallet();
      await api.connectAccount(connected, "Connected wallet");
      setAccountId(connected);
      await refreshTreasury();
      setStep("intensity");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connection failed.");
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
              How should money move?
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              Pick custody once. You can change it later from onboarding — not mid-chat — because each path uses a different account.
            </p>
            <div className="mt-6 grid gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={chooseApprovalPath}
                className="rounded-lg border border-line bg-card px-3.5 py-3 text-left transition-colors hover:bg-hover disabled:opacity-50"
              >
                <span className="text-[13px] font-medium text-ink">I approve each trade</span>
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
              Approval-gated mode uses the account you connect here. You will approve each trade in this same wallet.
            </p>
            <div className="mt-6 grid gap-2">
              {WALLETS.map((wallet) => (
                <button
                  key={wallet}
                  type="button"
                  disabled={!walletConfig.enabled || busy}
                  onClick={() => void onConnect()}
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
            <button
              type="button"
              disabled={busy}
              onClick={() => setStep(accountId ? "path" : "connect")}
              className="mt-3 rounded-control px-3 py-1.5 text-[12.5px] text-ink-3"
            >
              Back
            </button>
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
