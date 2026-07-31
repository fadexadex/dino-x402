import { useEffect, useState } from "react";
import { DinoMark } from "../agent/DinoMark";
import { api } from "../../lib/agent-api";
import { connectWallet, walletConfig } from "../../lib/wallet";

const WALLETS = ["HashPack", "Blade", "Kabila"] as const;

type Step = "connect" | "autonomy" | "fund" | "done";
type AutonomyChoice = 1 | 2 | 3 | 4;

const CHOICES: Array<{ mode: AutonomyChoice; title: string; detail: string }> = [
  {
    mode: 1,
    title: "Keep track of the market",
    detail: "Observe your connected wallet only. No advice, no trades.",
  },
  {
    mode: 2,
    title: "See what the agent would do",
    detail: "Watch holdings and get advice. Nothing executes.",
  },
  {
    mode: 3,
    title: "Stay in the loop",
    detail: "Agent prepares rebalances; you approve each trade before anything moves.",
  },
  {
    mode: 4,
    title: "Let the agent take full control",
    detail: "Requires a funded agent treasury. Trades run within your limits without per-trade approval.",
  },
];

/** Connect → choose autonomy → (optional) fund agent treasury → workspace. */
export function ConnectApp() {
  const [step, setStep] = useState<Step>("connect");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [choice, setChoice] = useState<AutonomyChoice | null>(null);
  const [agentAccountId, setAgentAccountId] = useState<string | null>(null);
  const [agentFunded, setAgentFunded] = useState(false);
  const [agentHbar, setAgentHbar] = useState(0);

  useEffect(() => {
    void api.getOnboarding().then((state) => {
      if (state.connectedAccountId) {
        setAccountId(state.connectedAccountId);
        setStep(state.autonomyMode && state.autonomyMode > 1 ? "done" : "autonomy");
      }
      if (state.agentTreasury) {
        setAgentAccountId(state.agentTreasury.accountId);
        setAgentFunded(state.agentTreasury.funded);
        setAgentHbar(state.agentTreasury.hbarFormatted);
      }
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

  const onConnect = async () => {
    if (!walletConfig.enabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      const connected = await connectWallet();
      await api.connectAccount(connected, "Connected wallet");
      setAccountId(connected);
      await refreshTreasury();
      setStep("autonomy");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connection failed.");
    } finally {
      setBusy(false);
    }
  };

  const onChoose = async (mode: AutonomyChoice) => {
    setChoice(mode);
    setError(null);
    if (mode === 4) {
      setBusy(true);
      try {
        const treasury = await refreshTreasury();
        if (!treasury?.accountId) {
          setError("Autonomous mode needs a configured agent treasury account on the server.");
          return;
        }
        setStep("fund");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load agent treasury.");
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      await api.completeOnboarding(mode);
      setStep("done");
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save autonomy choice.");
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
      const message = err instanceof Error ? err.message : "Could not enable autonomous mode.";
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="w-full max-w-md">
        <span className="flex items-center gap-2 text-ink">
          <DinoMark size={26} />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Dino Agent</span>
        </span>

        {step === "connect" && (
          <>
            <h1 className="mt-6 text-[22px] leading-tight font-semibold tracking-[-0.02em] text-ink">
              Connect an account to begin
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              First connect your Hedera testnet wallet. Next you will choose how much control the agent gets — from watch-only to a funded autonomous treasury.
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
          </>
        )}

        {step === "autonomy" && (
          <>
            <h1 className="mt-6 text-[22px] leading-tight font-semibold tracking-[-0.02em] text-ink">
              How should the agent work?
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              Connected as <span className="font-mono text-ink">{accountId}</span>. Money stays in your control unless you explicitly fund an agent treasury for full autonomy.
            </p>
            <div className="mt-6 grid gap-2">
              {CHOICES.map((item) => (
                <button
                  key={item.mode}
                  type="button"
                  disabled={busy}
                  onClick={() => void onChoose(item.mode)}
                  className="rounded-lg border border-line bg-card px-3.5 py-3 text-left transition-colors hover:bg-hover disabled:opacity-50"
                >
                  <span className="text-[13px] font-medium text-ink">{item.title}</span>
                  <span className="mt-1 block text-[12px] leading-relaxed text-ink-2">{item.detail}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === "fund" && (
          <>
            <h1 className="mt-6 text-[22px] leading-tight font-semibold tracking-[-0.02em] text-ink">
              Fund the agent treasury
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              Autonomous execution uses a server-managed agent treasury. Only assets you send here can be traded without per-trade approval. Transfer testnet HBAR (and USDC/SAUCE if you want them managed), then continue.
            </p>
            <div className="mt-6 rounded-lg border border-line bg-card px-3.5 py-3">
              <p className="text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">Server-managed agent treasury</p>
              <p className="mt-1 break-all font-mono text-[13px] text-ink">{agentAccountId ?? "—"}</p>
              <p className="mt-2 text-[12px] text-ink-2">
                Balance: <span className="font-mono text-ink">{agentHbar.toFixed(4)} ℏ</span>
                {agentFunded ? " · funded" : " · waiting for funds"}
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
                onClick={() => { setChoice(null); setStep("autonomy"); }}
                className="rounded-control px-3 py-1.5 text-[12.5px] text-ink-3"
              >
                Back
              </button>
            </div>
            {choice === 4 && (
              <p className="mt-4 text-[11px] leading-relaxed text-ink-2">
                Only assets you send to the agent treasury can be traded autonomously. Your connected wallet remains separate.
              </p>
            )}
          </>
        )}

        {step === "done" && (
          <div className="mt-6 rounded-lg border border-line bg-card px-3.5 py-3">
            <p className="text-[13px] text-ink">Onboarding complete. Opening workspace…</p>
            <a href="/" className="mt-3 inline-flex text-[12.5px] text-ink-2">Open workspace →</a>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 text-[11px] leading-relaxed text-orange">
            {error}
          </p>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-ink-2">
          {walletConfig.enabled
            ? "WalletConnect is ready for Hedera testnet. HashPack and Kabila appear in the QR / extension modal."
            : "WalletConnect is not enabled in this deployment. Set PUBLIC_REOWN_PROJECT_ID to enable connection."}
        </p>
        <a href="/" className="animated-underline mt-4 inline-block text-[12.5px] text-ink-2">
          Return to workspace →
        </a>
      </div>
    </main>
  );
}
