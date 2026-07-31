import type { BuiltSwapTransaction, SwapQuote, SwapResult } from "./types.js";
import { hashscanTransactionUrl } from "../agent/runner.js";
import { verifyMirrorSwap } from "./verification.js";

export interface ExecuteSaucerSwapParams {
  payerId: string;
  payerKey: string;
  quote: SwapQuote;
  transaction: BuiltSwapTransaction;
  gas?: number;
  mirrorBaseUrl?: string;
}

async function isAssociated(accountId: string, tokenId: string, mirrorBaseUrl: string): Promise<boolean> {
  const response = await fetch(
    `${mirrorBaseUrl}/api/v1/accounts/${encodeURIComponent(accountId)}/tokens?token.id=${encodeURIComponent(tokenId)}&limit=1`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!response.ok) throw new Error(`Unable to check token association (HTTP ${response.status})`);
  const body = await response.json() as { tokens?: Array<{ token_id?: string }> };
  return body.tokens?.some((token) => token.token_id === tokenId) ?? false;
}

/** Executes only an ABI-built SaucerSwap router call. It never substitutes a transfer. */
export async function executeSaucerSwap(params: ExecuteSaucerSwapParams): Promise<SwapResult> {
  const {
    Client, AccountId, PrivateKey, ContractId, ContractExecuteTransaction, Hbar,
    TokenAssociateTransaction, TokenId, AccountAllowanceApproveTransaction,
  } = await import("@hashgraph/sdk");
  const mirrorBaseUrl = (params.mirrorBaseUrl ?? "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");
  const client = Client.forTestnet();
  const payer = AccountId.fromString(params.payerId);
  const key = PrivateKey.fromStringECDSA(params.payerKey);
  const router = ContractId.fromString(params.transaction.contractId);
  client.setOperator(payer, key);
  try {
    if (params.quote.toToken !== "0.0.0" && !(await isAssociated(params.payerId, params.quote.toToken, mirrorBaseUrl))) {
      const association = await new TokenAssociateTransaction()
        .setAccountId(payer)
        .setTokenIds([TokenId.fromString(params.quote.toToken)])
        .freezeWith(client)
        .sign(key);
      const associationReceipt = await (await association.execute(client)).getReceipt(client);
      if (associationReceipt.status.toString() !== "SUCCESS") throw new Error(`Token association failed: ${associationReceipt.status}`);
    }

    if (params.quote.fromToken !== "0.0.0") {
      const allowance = await new AccountAllowanceApproveTransaction()
        .approveTokenAllowance(
          TokenId.fromString(params.quote.fromToken), payer,
          AccountId.fromString(params.transaction.contractId), params.quote.amountIn,
        )
        .freezeWith(client)
        .sign(key);
      const allowanceReceipt = await (await allowance.execute(client)).getReceipt(client);
      if (allowanceReceipt.status.toString() !== "SUCCESS") throw new Error(`Router allowance failed: ${allowanceReceipt.status}`);
    }

    let swap = new ContractExecuteTransaction()
      .setContractId(router)
      .setGas(params.gas ?? 15_000_000)
      .setFunctionParameters(params.transaction.encodedParameters)
      .setTransactionMemo(`Dino Agent ${params.quote.fromSymbol}->${params.quote.toSymbol}`);
    if (params.transaction.amountTinybar > 0n) swap = swap.setPayableAmount(Hbar.fromTinybars(params.transaction.amountTinybar));
    const signed = await swap.freezeWith(client).sign(key);
    const response = await signed.execute(client);
    const receipt = await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    if (receipt.status.toString() !== "SUCCESS") throw new Error(`SaucerSwap contract execution failed: ${receipt.status}`);

    let proof;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        proof = await verifyMirrorSwap(transactionId, {
          mirrorBaseUrl,
          receiverAccountId: params.payerId,
          ...(params.quote.toToken === "0.0.0" ? {} : {
            outputTokenId: params.quote.toToken,
            minimumOutput: params.transaction.amountOutMinimum,
          }),
        });
        if (proof.confirmed) break;
      } catch (error) {
        if (attempt === 7) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000 + attempt * 500));
    }
    if (!proof?.confirmed) throw new Error(`Mirror Node did not verify swap ${transactionId}`);
    const amountOut = params.quote.toToken === "0.0.0"
      ? params.quote.expectedAmountOut
      : proof.transfers
        .filter((transfer) => transfer.account === params.payerId && transfer.token === params.quote.toToken)
        .reduce((sum, transfer) => sum + BigInt(transfer.amount), 0n);
    const amountOutFormatted = params.quote.expectedAmountOut > 0n
      ? Number(amountOut) * params.quote.expectedAmountOutFormatted / Number(params.quote.expectedAmountOut)
      : undefined;
    return {
      success: true,
      transactionId,
      hashscanUrl: hashscanTransactionUrl(transactionId),
      fromToken: params.quote.fromToken,
      fromSymbol: params.quote.fromSymbol,
      toToken: params.quote.toToken,
      toSymbol: params.quote.toSymbol,
      amountIn: params.quote.amountIn,
      amountInFormatted: params.quote.amountInFormatted,
      amountOut,
      amountOutFormatted,
    };
  } finally {
    client.close();
  }
}

/** Kept only to make old callers fail closed during migration. */
export async function executeHbarTransfer(): Promise<never> {
  throw new Error("Plain HBAR transfers are not swaps. Use executeSaucerSwap with a verified quote.");
}
