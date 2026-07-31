import { hashscanTransactionUrl } from "../agent/runner.js";
import type { SwapVerification } from "./types.js";

export interface MirrorTransactionResponse {
  transactions?: Array<{
    result?: string;
    transaction_id?: string;
    transfers?: Array<{ account?: string; amount?: number }>;
    token_transfers?: Array<{ token_id?: string; account?: string; amount?: number }>;
  }>;
}

/** Verification is intentionally independent of SDK receipts: Mirror Node is the proof shown to users. */
export async function verifyMirrorSwap(
  transactionId: string,
  options: {
    mirrorBaseUrl?: string;
    fetchFn?: typeof fetch;
    receiverAccountId?: string;
    outputTokenId?: string;
    minimumOutput?: bigint;
  } = {},
): Promise<SwapVerification> {
  const base = options.mirrorBaseUrl ?? "https://testnet.mirrornode.hedera.com";
  const mirrorTransactionId = transactionId.includes("@")
    ? transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1")
    : transactionId;
  const response = await (options.fetchFn ?? fetch)(`${base}/api/v1/transactions/${encodeURIComponent(mirrorTransactionId)}`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Mirror verification HTTP ${response.status}`);
  const data = await response.json() as MirrorTransactionResponse;
  const transactions = data.transactions ?? [];
  const transaction = transactions[0];
  if (!transaction) throw new Error("Mirror Node has no transaction record yet");
  const status = transaction.result ?? "UNKNOWN";
  const transfers: SwapVerification["transfers"] = transactions.flatMap((entry) => [
    ...(entry.transfers ?? []).flatMap((transfer) => transfer.account && transfer.amount !== undefined
      ? [{ account: transfer.account, amount: transfer.amount }]
      : []),
    ...(entry.token_transfers ?? []).flatMap((transfer) => transfer.account && transfer.amount !== undefined && transfer.token_id
      ? [{ account: transfer.account, amount: transfer.amount, token: transfer.token_id }]
      : []),
  ]) as SwapVerification["transfers"];
  let confirmed = status === "SUCCESS";
  if (confirmed && options.receiverAccountId && options.outputTokenId && options.minimumOutput !== undefined) {
    const output = transfers
      .filter((transfer) => transfer.account === options.receiverAccountId && transfer.token === options.outputTokenId)
      .reduce((sum, transfer) => sum + BigInt(transfer.amount), 0n);
    confirmed = output >= options.minimumOutput;
    if (!confirmed) throw new Error(`Mirror Node did not prove the minimum ${options.outputTokenId} output`);
  }
  return { confirmed, transactionId, status, transfers };
}

export const swapProofUrl = (transactionId: string): string => hashscanTransactionUrl(transactionId);
