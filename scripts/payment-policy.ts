export interface PaymentRequirementLike {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}

export interface PaymentRequiredLike {
  x402Version: number;
  resource: { url: string };
  accepts: PaymentRequirementLike[];
}

export interface PaymentPolicy {
  network: string;
  asset: string;
  payTo: string;
  maxAmountAtomic: bigint;
  allowedOrigin: string;
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

const parseOrigin = (value: string, name: string): string => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    return url.origin;
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
};

export const loadPaymentPolicy = (env: NodeJS.ProcessEnv = process.env): PaymentPolicy => {
  const rawMax = required(env, "SIGNER_MAX_AMOUNT_ATOMIC");
  if (!/^\d+$/.test(rawMax) || BigInt(rawMax) <= 0n) {
    throw new Error("SIGNER_MAX_AMOUNT_ATOMIC must be a positive integer");
  }

  const allowedOrigin = env.SIGNER_ALLOWED_ORIGIN?.trim() || required(env, "SERVER_URL");

  return {
    network: required(env, "HEDERA_NETWORK"),
    asset: env.SIGNER_ALLOWED_ASSET?.trim() || "0.0.0",
    payTo: required(env, "PAY_TO_ACCOUNT"),
    maxAmountAtomic: BigInt(rawMax),
    allowedOrigin: parseOrigin(allowedOrigin, "SIGNER_ALLOWED_ORIGIN/SERVER_URL"),
  };
};

const validAtomicAmount = (amount: string): boolean => /^\d+$/.test(amount);

/**
 * Fail-closed policy for autonomous payment creation.
 *
 * The returned challenge contains only the single approved payment option, so
 * the x402 client's normal selection logic cannot choose a less restrictive
 * alternative advertised by an untrusted resource server.
 */
export const applyPaymentPolicy = <T extends PaymentRequiredLike>(
  paymentRequired: T,
  policy: PaymentPolicy,
): T => {
  if (paymentRequired.x402Version !== 2) {
    throw new Error(`Payment rejected by policy: x402 version ${paymentRequired.x402Version}`);
  }

  const resourceOrigin = parseOrigin(paymentRequired.resource.url, "payment resource URL");
  if (resourceOrigin !== policy.allowedOrigin) {
    throw new Error(`Payment rejected by policy: resource origin ${resourceOrigin} is not allowed`);
  }

  const selected = paymentRequired.accepts.find((requirement) => {
    if (!validAtomicAmount(requirement.amount)) return false;
    return (
      requirement.scheme === "exact" &&
      requirement.network === policy.network &&
      requirement.asset === policy.asset &&
      requirement.payTo === policy.payTo &&
      BigInt(requirement.amount) <= policy.maxAmountAtomic
    );
  });

  if (!selected) {
    throw new Error(
      "Payment rejected by policy: no exact payment option matches the allowed origin, network, asset, payee, and amount cap",
    );
  }

  return Object.assign({}, paymentRequired, { accepts: [selected] }) as T;
};
