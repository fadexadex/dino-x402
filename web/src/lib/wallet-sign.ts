import {
  AccountAllowanceApproveTransaction,
  AccountId,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  TokenAssociateTransaction,
  TokenId,
} from "@hiero-ledger/sdk";
import { connectWallet, getConnectedAccountId, getConnector } from "./wallet";

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

async function isAssociated(accountId: string, tokenId: string): Promise<boolean> {
  const response = await fetch(
    `https://testnet.mirrornode.hedera.com/api/v1/accounts/${encodeURIComponent(accountId)}/tokens?token.id=${encodeURIComponent(tokenId)}&limit=1`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!response.ok) throw new Error(`Unable to check token association (HTTP ${response.status})`);
  const body = await response.json() as { tokens?: Array<{ token_id?: string }> };
  return body.tokens?.some((token) => token.token_id === tokenId) ?? false;
}

/** Asks the connected user wallet to prepare (associate/allow) and submit the swap. */
export async function signAndExecuteSwap(
  accountId: string,
  signing: SwapSigningPackage,
): Promise<{ transactionId: string }> {
  const dapp = await getConnector();
  let connected = getConnectedAccountId(dapp);
  if (!connected) connected = await connectWallet();
  if (connected !== accountId) {
    throw new Error(`Connected wallet ${connected} does not match the proposal account ${accountId}. Reconnect the right account, then approve again.`);
  }

  const signer = dapp.getSigner(AccountId.fromString(accountId));
  const toToken = signing.quote.toToken;
  const fromToken = signing.quote.fromToken;

  // Mirror the server executor: associate the receive token, then approve router spend.
  if (toToken && toToken !== "0.0.0" && !(await isAssociated(accountId, toToken))) {
    const association = await new TokenAssociateTransaction()
      .setAccountId(AccountId.fromString(accountId))
      .setTokenIds([TokenId.fromString(toToken)])
      .freezeWithSigner(signer);
    const signedAssociation = await association.signWithSigner(signer);
    const associationResponse = await signedAssociation.executeWithSigner(signer);
    const associationId = associationResponse.transactionId?.toString();
    if (!associationId) throw new Error("Wallet associated the token but returned no transaction id.");
  }

  if (fromToken && fromToken !== "0.0.0") {
    const amountIn = BigInt(signing.quote.amountIn ?? "0");
    if (amountIn <= 0n) throw new Error("Missing swap input amount for token allowance.");
    const allowance = await new AccountAllowanceApproveTransaction()
      .approveTokenAllowance(
        TokenId.fromString(fromToken),
        AccountId.fromString(accountId),
        AccountId.fromString(signing.contractId),
        amountIn,
      )
      .freezeWithSigner(signer);
    const signedAllowance = await allowance.signWithSigner(signer);
    const allowanceResponse = await signedAllowance.executeWithSigner(signer);
    const allowanceId = allowanceResponse.transactionId?.toString();
    if (!allowanceId) throw new Error("Wallet approved the router spend but returned no transaction id.");
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

  const frozen = await transaction.freezeWithSigner(signer);
  const signed = await frozen.signWithSigner(signer);
  const response = await signed.executeWithSigner(signer);
  const transactionId = response.transactionId?.toString();
  if (!transactionId) throw new Error("Wallet submitted the swap but returned no transaction id.");
  return { transactionId };
}
