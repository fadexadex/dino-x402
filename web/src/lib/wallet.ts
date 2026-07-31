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

/**
 * WalletConnect Core is a process-wide singleton. Calling SignClient.init() a
 * second time logs "Core is already initialized" and breaks proposal keys
 * ("No matching key. proposal: …"). Never destroy/recreate the connector —
 * only disconnect sessions on the existing client, then openModal again.
 */
async function disconnectSessions(connector: DAppConnector): Promise<void> {
  const client = connector.walletConnectClient;
  if (!client) {
    connector.signers = [];
    return;
  }
  const sessions = client.session.getAll();
  const pairings = client.core.pairing.getPairings();
  await Promise.allSettled([
    ...sessions.map((session) => connector.disconnect(session.topic)),
    ...pairings.map((pairing) => connector.disconnect(pairing.topic)),
  ]);
  connector.signers = [];
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

/** Drop active sessions/pairings without re-initializing WalletConnect Core. */
export async function resetConnector(): Promise<void> {
  if (!connectorPromise) return;
  try {
    const connector = await connectorPromise;
    await disconnectSessions(connector);
  } catch {
    // Session already dead — treat as cleared.
  }
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
export async function connectWallet(options?: { force?: boolean }): Promise<string> {
  const connector = await getConnector();
  if (options?.force) {
    await disconnectSessions(connector);
  } else {
    const existing = getConnectedAccountId(connector);
    if (existing) return existing;
  }

  await connector.openModal(undefined, true);
  const accountId = getConnectedAccountId(connector);
  if (!accountId) {
    throw new Error("Wallet approved the session but no Hedera account ID was returned.");
  }
  return accountId;
}

export async function disconnectWallet(): Promise<void> {
  await resetConnector();
}
