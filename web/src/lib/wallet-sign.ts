import {
  AccountAllowanceApproveTransaction,
  AccountId,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  TokenAssociateTransaction,
  TokenId,
  Transaction,
  type TransactionResponse,
} from "@hiero-ledger/sdk";
import { connectWallet, getConnectedAccountId, getConnector, walletConfig } from "./wallet";

export type SwapSigningPackage = {
  contractId: string;
  encodedParameters: string;
  amountTinybar: string;
  quote: {
    fromSymbol: string;
    toSymbol: string;
    fromToken: string;
    toToken: string;
    amountIn?: string;
  };
};

type DAppConnector = Awaited<ReturnType<typeof getConnector>>;
type HederaSigner = ReturnType<DAppConnector["getSigner"]>;

/**
 * WalletConnect's freezeWithSigner → populateTransaction only sets the transaction ID.
 * freeze() still needs node routing. Use a single testnet node — multi-node lists make
 * HashPack serialize a TransactionList per node and are a common source of WC flakiness.
 */
const TESTNET_NODE_ACCOUNT_IDS = [new AccountId(3)];

function errorText(error: unknown): string {
  if (error instanceof Error) {
    // DAppSigner.call nests errors as JSON strings — flatten them for matching.
    return `${error.message} ${error.stack ?? ""}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? "");
  }
}

function isStaleSessionError(error: unknown): boolean {
  return /Query\.fromBytes|no matching key|failed to process an inbound message|session topic doesn't exist|no matching session|missing or invalid|unauthorized|session no longer exists|without any listeners|websocket|failed to process/i.test(
    errorText(error),
  );
}

function prepareForWalletSigner<T extends Transaction>(transaction: T): T {
  return transaction.setNodeAccountIds(TESTNET_NODE_ACCOUNT_IDS) as T;
}

function friendlyWalletError(error: unknown): Error {
  const message = errorText(error);
  if (/nodeAccountId must be set|client must be provided with freezeWith|list is locked/i.test(message)) {
    return new Error("Could not prepare the Hedera transaction for your wallet. Try Approve again.");
  }
  if (isStaleSessionError(error)) {
    return new Error(
      "WalletConnect lost the session (pairing key mismatch). Click Approve again, complete the fresh HashPack pair, and keep this tab focused until the swap prompt finishes.",
    );
  }
  if (/user rejected|denied|closed|cancel/i.test(message)) {
    return new Error("Wallet prompt was closed or rejected. Click Approve in wallet again when ready.");
  }
  return error instanceof Error ? error : new Error(message.slice(0, 280));
}

async function isAssociated(accountId: string, tokenId: string): Promise<boolean> {
  const response = await fetch(
    `https://testnet.mirrornode.hedera.com/api/v1/accounts/${encodeURIComponent(accountId)}/tokens?token.id=${encodeURIComponent(tokenId)}&limit=1`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!response.ok) throw new Error(`Unable to check token association (HTTP ${response.status})`);
  const body = await response.json() as { tokens?: Array<{ token_id?: string }> };
  return body.tokens?.some((token) => token.token_id === tokenId) ?? false;
}

async function checkMirrorNodeSuccess(transactionId: string, iteration: number = 0): Promise<boolean> {
  try {
    const parts = transactionId.split('@');
    if (parts.length !== 2) return false;
    const accountId = parts[0];
    const timestamp = parts[1].replace('.', '-');
    const mirrorId = `${accountId}-${timestamp}`;
    
    // The Mirror Node rejects arbitrary query parameters (like ?nocache=...) on the /transactions/{id} endpoint with a 400 Bad Request.
    // Cloudflare edge aggressively caches 404s. To bust the cache, we use the generic search endpoint for the account's recent transactions.
    // By slightly varying a valid `timestamp=gt:...` parameter on each iteration, we guarantee a unique URL that bypasses the CDN cache.
    const cacheBusterTimestamp = Math.floor(Date.now() / 1000) - 86400 + iteration;
    const url = `https://testnet.mirrornode.hedera.com/api/v1/transactions?account.id=${accountId}&timestamp=gt:${cacheBusterTimestamp}&limit=100&order=desc`;
    
    const response = await fetch(url, {
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (response.ok) {
      const data = await response.json() as { transactions?: Array<{ transaction_id?: string, result?: string }> };
      if (data.transactions?.some((t) => t.transaction_id === mirrorId && t.result === "SUCCESS")) {
        return true;
      }
    }
  } catch (error) {
    // Ignore fetch errors
  }
  return false;
}

/** One WalletConnect round-trip: freeze → SignAndExecute (do NOT also signWithSigner). */
async function sendWithWallet(signer: HederaSigner, transaction: Transaction): Promise<string> {
  const frozen = await prepareForWalletSigner(transaction).freezeWithSigner(signer);
  const transactionId = frozen.transactionId?.toString();
  if (!transactionId) throw new Error("Could not determine transaction ID before signing.");
  
  try {
    return await Promise.race([
      frozen.executeWithSigner(signer).then(() => transactionId),
      // WalletConnect v2 websockets frequently drop responses, causing executeWithSigner to hang indefinitely.
      // We concurrently poll the Mirror Node for up to 90 seconds. If the transaction succeeds on-chain,
      // we can safely resolve and ignore WalletConnect's hanging promise.
      (async () => {
        await new Promise((r) => setTimeout(r, 4000));
        for (let i = 0; i < 45; i++) {
          if (await checkMirrorNodeSuccess(transactionId, i)) return transactionId;
          await new Promise((r) => setTimeout(r, 2000));
        }
        throw new Error("WalletConnect did not respond and the transaction was not found on the network after 90 seconds.");
      })()
    ]);
  } catch (error) {
    // If WalletConnect crashed but the user already approved it, it might have succeeded on-chain.
    const message = errorText(error);
    if (/Query\.fromBytes/i.test(message) || isStaleSessionError(error)) {
      // It threw an error quickly, so the polling promise above was cancelled by the Promise.race rejection.
      // We must poll again here for a few seconds to give the Mirror Node time to index it.
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await checkMirrorNodeSuccess(transactionId, i)) return transactionId;
      }
    }
    throw error;
  }
}

/**
 * Mode 3 signing needs a live WalletConnect pairing.
 * Default is a clean force-pair — restored IndexedDB sessions replay undecryptable
 * relay messages ("failed to process an inbound message" / "without any listeners").
 * Pass reuseSession when the caller just finished connectWallet({ force: true }).
 */
async function ensureWalletSession(
  accountId: string,
  options: { reuseSession?: boolean } = {},
): Promise<HederaSigner> {
  if (!walletConfig.enabled) {
    throw new Error("WalletConnect is not configured. Set PUBLIC_REOWN_PROJECT_ID in the web env, then reconnect.");
  }
  let connected: string | null = null;
  if (options.reuseSession) {
    const dapp = await getConnector();
    connected = getConnectedAccountId(dapp);
  }
  if (!connected || connected !== accountId) {
    connected = await connectWallet({ force: !options.reuseSession || connected !== accountId });
  }
  if (connected !== accountId) {
    throw new Error(
      `Connected wallet ${connected} does not match the proposal account ${accountId}. Switch to ${accountId} in your wallet, then approve again.`,
    );
  }
  const dapp = await getConnector();
  return dapp.getSigner(AccountId.fromString(accountId));
}

async function submitSwap(signer: HederaSigner, accountId: string, signing: SwapSigningPackage): Promise<string> {
  const toToken = signing.quote.toToken;
  const fromToken = signing.quote.fromToken;

  if (toToken && toToken !== "0.0.0" && !(await isAssociated(accountId, toToken))) {
    await sendWithWallet(
      signer,
      new TokenAssociateTransaction()
        .setAccountId(AccountId.fromString(accountId))
        .setTokenIds([TokenId.fromString(toToken)]),
    );
  }

  if (fromToken && fromToken !== "0.0.0") {
    const amountIn = BigInt(signing.quote.amountIn ?? "0");
    if (amountIn <= 0n) throw new Error("Missing swap input amount for token allowance.");
    await sendWithWallet(
      signer,
      new AccountAllowanceApproveTransaction()
        .approveTokenAllowance(
          TokenId.fromString(fromToken),
          AccountId.fromString(accountId),
          AccountId.fromString(signing.contractId),
          amountIn,
        ),
    );
  }

  let transaction = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(signing.contractId))
    .setGas(15_000_000)
    .setFunctionParameters(Uint8Array.from(atob(signing.encodedParameters), (c) => c.charCodeAt(0)))
    .setTransactionMemo(`Dino Agent ${signing.quote.fromSymbol}->${signing.quote.toSymbol}`);

  const payable = BigInt(signing.amountTinybar);
  if (payable > 0n) {
    transaction = transaction.setPayableAmount(Hbar.fromTinybars(payable.toString()));
  }

  return sendWithWallet(signer, transaction);
}

/** Asks the connected user wallet to prepare (associate/allow) and submit the swap. */
export async function signAndExecuteSwap(
  accountId: string,
  signing: SwapSigningPackage,
  options: { reuseSession?: boolean } = {},
): Promise<{ transactionId: string }> {
  try {
    const signer = await ensureWalletSession(accountId, options);
    const transactionId = await submitSwap(signer, accountId, signing);
    return { transactionId };
  } catch (error) {
    throw friendlyWalletError(error);
  }
}
