import "dotenv/config";
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
} from "@hiero-ledger/sdk";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

const network = process.env.HEDERA_NETWORK ?? "hedera:testnet";
if (network !== "hedera:testnet") {
  throw new Error(`Receiver creation is testnet-only, received ${network}`);
}

const payerId = AccountId.fromString(required("HEDERA_CLIENT_ID"));
const payerKey = PrivateKey.fromStringECDSA(required("HEDERA_CLIENT_KEY"));
const client = Client.forTestnet().setOperator(payerId, payerKey);

try {
  // A distinct account makes the transfer leg unambiguous on HashScan. Reusing
  // the payer's public key avoids creating or printing another private key.
  const response = await new AccountCreateTransaction()
    .setKey(payerKey.publicKey)
    .setInitialBalance(new Hbar(1))
    .execute(client);
  const receipt = await response.getReceipt(client);
  const accountId = receipt.accountId;
  if (!accountId) throw new Error("Account creation succeeded without an account ID in the receipt");

  const transactionId = response.transactionId.toString();
  const hashscanTransactionId = transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1");

  console.log(`PAY_TO_ACCOUNT=${accountId.toString()}`);
  console.log(`HASHSCAN=https://hashscan.io/testnet/transaction/${hashscanTransactionId}`);
} finally {
  client.close();
}
