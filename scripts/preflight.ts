import "dotenv/config";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
};

const checks: Array<() => Promise<CheckResult>> = [
  async () => {
    const payer = required("HEDERA_CLIENT_ID");
    const receiver = required("PAY_TO_ACCOUNT");
    if (payer === receiver) throw new Error("payer and receiver must be distinct");
    const network = required("HEDERA_NETWORK");
    if (network !== "hedera:testnet") throw new Error(`expected hedera:testnet, got ${network}`);
    required("HEDERA_CLIENT_KEY");
    return { name: "configuration", ok: true, detail: `${network}; payer/payee distinct; signer present` };
  },
  async () => {
    const base = required("FACILITATOR_URL").replace(/\/$/, "");
    const body = await fetchJson<{ kinds?: Array<{ scheme?: string; network?: string; x402Version?: number }> }>(`${base}/supported`);
    const supported = body.kinds?.some((kind) => kind.x402Version === 2 && kind.scheme === "exact" && kind.network === "hedera:testnet");
    if (!supported) throw new Error("exact hedera:testnet x402 v2 is not advertised");
    return { name: "Blocky402", ok: true, detail: "x402 v2 exact / hedera:testnet supported" };
  },
  async () => {
    const accounts = [required("HEDERA_CLIENT_ID"), required("PAY_TO_ACCOUNT")];
    const balances: string[] = [];
    for (const account of accounts) {
      const body = await fetchJson<{ balance?: { balance?: number } }>(
        `https://testnet.mirrornode.hedera.com/api/v1/accounts/${encodeURIComponent(account)}`,
      );
      const tinybar = body.balance?.balance;
      if (typeof tinybar !== "number") throw new Error(`missing balance for ${account}`);
      balances.push(`${account}=${(tinybar / 1e8).toFixed(4)} HBAR`);
    }
    return { name: "Hedera mirror", ok: true, detail: balances.join("; ") };
  },
  async () => {
    const body = await fetchJson<Record<string, { usd?: number }>>(
      "https://api.coingecko.com/api/v3/simple/price?ids=hedera-hashgraph&vs_currencies=usd",
      { headers: { accept: "application/json", "user-agent": "MarketRail-x402-demo/1.0" } },
    );
    const price = body["hedera-hashgraph"]?.usd;
    if (typeof price !== "number") throw new Error("HBAR/USD was absent");
    return { name: "CoinGecko", ok: true, detail: `live HBAR/USD available (${price})` };
  },
  async () => {
    const model = process.env.MISTRAL_MODEL?.trim() || "mistral-small-latest";
    const apiKey = required("MISTRAL_API_KEY");
    const body = await fetchJson<{ data?: Array<{ id?: string }> }>("https://api.mistral.ai/v1/models", {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    });
    const models = body.data?.map((item) => item.id).filter(Boolean) ?? [];
    if (!models.includes(model)) throw new Error(`configured model ${model} is unavailable`);
    return { name: "Mistral", ok: true, detail: `${model} available` };
  },
];
const checkNames = ["configuration", "Blocky402", "Hedera mirror", "CoinGecko", "Mistral"];

const results: CheckResult[] = [];
for (const check of checks) {
  try {
    results.push(await check());
  } catch (error) {
    results.push({
      name: checkNames[results.length] ?? `check ${results.length + 1}`,
      ok: false,
      detail: error instanceof Error ? error.message : "unknown failure",
    });
  }
}

for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
}

if (results.some((result) => !result.ok)) {
  throw new Error("Preflight failed; resolve the checks above before recording the demo");
}

console.log("READY All external dependencies passed preflight");
