import { Buffer } from "buffer";
import {
  DAppConnector,
  HederaChainId,
  HederaJsonRpcMethod,
  HederaSessionEvent,
} from "@hashgraph/hedera-wallet-connect";
import { LedgerId } from "@hiero-ledger/sdk";

declare global {
  interface Window {
    Buffer?: typeof Buffer;
  }
}

if (typeof window !== "undefined" && !window.Buffer) {
  window.Buffer = Buffer;
}

const projectId = import.meta.env.PUBLIC_REOWN_PROJECT_ID?.trim() ?? "";
const appUrl = (import.meta.env.PUBLIC_APP_URL?.trim() || "http://localhost:4321").replace(/\/$/, "");

export const walletConfig = {
  projectId,
  enabled: Boolean(projectId),
  metadata: {
    name: "Dino Agent",
    description: "Multi-asset intelligence on Hedera testnet",
    url: appUrl,
    icons: [`${appUrl}/favicon.svg`],
  },
};

let connectorPromise: Promise<DAppConnector> | null = null;

function accountIdFromCaip(value: string): string | null {
  const parts = value.split(":");
  const candidate = parts[parts.length - 1];
  return /^0\.0\.\d+$/.test(candidate) ? candidate : null;
}

export async function getConnector(): Promise<DAppConnector> {
  if (!walletConfig.enabled) {
    throw new Error("WalletConnect is not configured. Set PUBLIC_REOWN_PROJECT_ID.");
  }
  if (!connectorPromise) {
    connectorPromise = (async () => {
      const connector = new DAppConnector(
        walletConfig.metadata,
        LedgerId.TESTNET,
        walletConfig.projectId,
        Object.values(HederaJsonRpcMethod),
        [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
        [HederaChainId.Testnet],
      );
      await connector.init({ logger: "error" });
      return connector;
    })();
  }
  return connectorPromise;
}

export function getConnectedAccountId(connector: DAppConnector): string | null {
  const fromSigner = connector.signers[0]?.getAccountId()?.toString();
  if (fromSigner && /^0\.0\.\d+$/.test(fromSigner)) return fromSigner;

  const sessions = connector.walletConnectClient?.session.getAll() ?? [];
  for (const session of sessions) {
    for (const namespace of Object.values(session.namespaces ?? {})) {
      for (const account of namespace.accounts ?? []) {
        const id = accountIdFromCaip(account);
        if (id) return id;
      }
    }
  }
  return null;
}

/** Opens the WalletConnect modal and returns the approved Hedera account ID. */
export async function connectWallet(): Promise<string> {
  const connector = await getConnector();
  const existing = getConnectedAccountId(connector);
  if (existing) return existing;

  await connector.openModal(undefined, true);
  const accountId = getConnectedAccountId(connector);
  if (!accountId) {
    throw new Error("Wallet approved the session but no Hedera account ID was returned.");
  }
  return accountId;
}

export async function disconnectWallet(): Promise<void> {
  if (!connectorPromise) return;
  const connector = await connectorPromise;
  if (connector.walletConnectClient) {
    await connector.disconnectAll();
  }
}
