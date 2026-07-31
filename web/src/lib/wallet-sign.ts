import { AccountId, ContractExecuteTransaction, ContractId, Hbar } from "@hiero-ledger/sdk";
import { connectWallet, getConnectedAccountId, getConnector } from "./wallet";

export type SwapSigningPackage = {
  contractId: string;
  encodedParameters: string;
  amountTinybar: string;
  quote: { fromSymbol: string; toSymbol: string; fromToken: string; toToken: string };
};

/** Asks the connected user wallet to sign and submit the SaucerSwap contract call. */
export async function signAndExecuteSwap(
  accountId: string,
  signing: SwapSigningPackage,
): Promise<{ transactionId: string }> {
  const dapp = await getConnector();
  let connected = getConnectedAccountId(dapp);
  if (!connected) connected = await connectWallet();
  if (connected !== accountId) {
    throw new Error(`Connected wallet ${connected} does not match the proposal account ${accountId}.`);
  }

  const signer = dapp.getSigner(AccountId.fromString(accountId));
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
