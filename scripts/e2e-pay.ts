import "dotenv/config";
import {
    createClientHederaSigner,
    PrivateKey as HederaPrivateKey,
} from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import {
    decodePaymentRequiredHeader,
    encodePaymentSignatureHeader,
} from "@x402/core/http";
import { applyPaymentPolicy, loadPaymentPolicy } from "./payment-policy.js";

const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
};

const accountId = required("HEDERA_CLIENT_ID");
const privateKey = required("HEDERA_CLIENT_KEY");
const serverUrl = process.env.SERVER_URL ?? "http://localhost:4021";
const product = process.env.E2E_PRODUCT ?? "spot-price";
const symbol = process.env.E2E_SYMBOL ?? "AAPL";
const network = process.env.HEDERA_NETWORK ?? "hedera:testnet";
const payTo = required("PAY_TO_ACCOUNT");

if (accountId === payTo) {
    throw new Error("HEDERA_CLIENT_ID and PAY_TO_ACCOUNT must be different accounts");
}
if (network !== "hedera:testnet") {
    throw new Error(`Live bounty verification requires hedera:testnet, received ${network}`);
}

// Note: fromStringECDSA matches Hedera Portal default accounts.
// If your account key is ED25519, switch to HederaPrivateKey.fromStringED25519.
const signer = createClientHederaSigner(
    accountId,
    HederaPrivateKey.fromStringECDSA(privateKey),
    { network },
);

const client = new x402Client().register(
    "hedera:*",
    new ExactHederaScheme(signer),
);
const httpClient = new x402HTTPClient(client);

const url = `${serverUrl}/data/${product}?symbol=${encodeURIComponent(symbol)}`;

console.log(`[1/6] REQUEST_SENT ${url}`);
const challengeResponse = await fetch(url);
if (challengeResponse.status !== 402) {
    throw new Error(`Expected the unpaid request to return 402, received ${challengeResponse.status}`);
}

const paymentRequiredHeader = challengeResponse.headers.get("payment-required");
if (!paymentRequiredHeader) throw new Error("402 response did not include payment-required");

const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
console.log(`[2/6] PAYMENT_REQUIRED x402Version=${paymentRequired.x402Version}`);
const approvedPaymentRequired = applyPaymentPolicy(paymentRequired, loadPaymentPolicy());
const accepted = approvedPaymentRequired.accepts[0];
if (!accepted) throw new Error("Payment policy returned no approved payment option");
console.log(
    `[3/6] POLICY_APPROVED amount=${accepted.amount} asset=${accepted.asset} payTo=${accepted.payTo}`,
);

const payload = await client.createPaymentPayload(approvedPaymentRequired);
console.log("[4/6] PAYMENT_SIGNED key_material=redacted");
const res = await fetch(url, {
    headers: { "payment-signature": encodePaymentSignatureHeader(payload) },
});
if (res.status !== 200) {
    throw new Error(`Paid retry returned HTTP ${res.status}: ${await res.text()}`);
}

const body = await res.json();

const settlement = httpClient.getPaymentSettleResponse((name) =>
    res.headers.get(name),
);
if (!settlement?.success || !settlement.transaction) {
    throw new Error("Paid response did not include a successful settlement proof");
}

console.log(`[5/6] HEDERA_SETTLED transaction=${settlement.transaction}`);
console.log(`[6/6] DATA_RETURNED ${JSON.stringify(body)}`);

const hashscanTransactionId = settlement.transaction
    .replace("@", "-")
    .replace(/\.(\d+)$/, "-$1");
const hashscanUrl = `https://hashscan.io/testnet/transaction/${hashscanTransactionId}`;
console.log(`HASHSCAN ${hashscanUrl}`);

const mirrorUrl = `https://testnet.mirrornode.hedera.com/api/v1/transactions/${encodeURIComponent(
    hashscanTransactionId,
)}`;
let mirrorTransaction: {
    result?: string;
    transfers?: Array<{ account: string; amount: number }>;
} | undefined;

for (let attempt = 1; attempt <= 10; attempt++) {
    const mirrorResponse = await fetch(mirrorUrl);
    if (mirrorResponse.ok) {
        const mirrorBody = (await mirrorResponse.json()) as { transactions?: typeof mirrorTransaction[] };
        mirrorTransaction = mirrorBody.transactions?.[0];
        if (mirrorTransaction) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
}

if (!mirrorTransaction) throw new Error("Settlement was not indexed by the testnet mirror node");
if (mirrorTransaction.result !== "SUCCESS") {
    throw new Error(`Mirror node reports transaction result ${mirrorTransaction.result ?? "unknown"}`);
}

const amount = Number(accepted.amount);
const transfers = mirrorTransaction.transfers ?? [];
const receiverCredit = transfers.some((transfer) => transfer.account === payTo && transfer.amount === amount);
const payerDebit = transfers.some((transfer) => transfer.account === accountId && transfer.amount === -amount);
if (!receiverCredit || !payerDebit) {
    throw new Error("Mirror-node transfer list did not contain the expected payer debit and receiver credit");
}

console.log(`MIRROR_VERIFIED result=SUCCESS payer=${accountId} receiver=${payTo} amount=${accepted.amount}`);
