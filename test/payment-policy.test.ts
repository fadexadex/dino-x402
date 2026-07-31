import { describe, expect, it } from "vitest";
import { applyPaymentPolicy, loadPaymentPolicy } from "../scripts/payment-policy.js";

const policy = {
  network: "hedera:testnet",
  asset: "0.0.0",
  payTo: "0.0.2222",
  maxAmountAtomic: 5_000_000n,
  allowedOrigin: "http://localhost:4021",
};

const challenge = (overrides: Record<string, unknown> = {}) => ({
  x402Version: 2,
  resource: { url: "http://localhost:4021/data/spot-price?symbol=AAPL" },
  accepts: [
    {
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.0",
      amount: "1000000",
      payTo: "0.0.2222",
      ...overrides,
    },
  ],
});

describe("autonomous payment policy", () => {
  it("keeps one approved exact HBAR option", () => {
    expect(applyPaymentPolicy(challenge(), policy).accepts).toHaveLength(1);
  });

  it("drops untrusted alternatives before the x402 client selects a payment", () => {
    const input = challenge();
    input.accepts.unshift({ ...input.accepts[0]!, amount: "999999999", payTo: "0.0.9999" });
    const approved = applyPaymentPolicy(input, policy);
    expect(approved.accepts).toHaveLength(1);
    expect(approved.accepts[0]?.payTo).toBe(policy.payTo);
    expect(approved.accepts[0]?.amount).toBe("1000000");
  });

  it.each([
    ["amount cap", { amount: "5000001" }],
    ["payee", { payTo: "0.0.9999" }],
    ["asset", { asset: "0.0.429274" }],
    ["network", { network: "hedera:mainnet" }],
    ["scheme", { scheme: "upto" }],
    ["malformed amount", { amount: "1.5" }],
  ])("rejects a challenge outside the %s policy", (_name, overrides) => {
    expect(() => applyPaymentPolicy(challenge(overrides), policy)).toThrow(/rejected by policy/);
  });

  it("rejects a different resource origin", () => {
    const input = challenge();
    input.resource.url = "https://malicious.example/data";
    expect(() => applyPaymentPolicy(input, policy)).toThrow(/origin/);
  });

  it("rejects non-http resource URLs", () => {
    const input = challenge();
    input.resource.url = "file:///tmp/challenge";
    expect(() => applyPaymentPolicy(input, policy)).toThrow(/http\(s\)/);
  });

  it("fails closed when the amount cap is missing", () => {
    expect(() =>
      loadPaymentPolicy({
        HEDERA_NETWORK: "hedera:testnet",
        PAY_TO_ACCOUNT: "0.0.2222",
        SERVER_URL: "http://localhost:4021",
      }),
    ).toThrow(/SIGNER_MAX_AMOUNT_ATOMIC/);
  });
});
