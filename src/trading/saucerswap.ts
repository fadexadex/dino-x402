import { ContractId, TokenId } from "@hashgraph/sdk";
import { Interface, getBytes, hexlify } from "ethers";
import type { BuiltSwapTransaction, SaucerSwapConfig, SwapQuote } from "./types.js";

/** Documented V2 testnet contracts. Deployments are configurable to avoid baking in network state. */
export const DEFAULT_SAUCERSWAP_TESTNET: SaucerSwapConfig = {
  routerId: "0.0.1414040",
  quoterId: "0.0.1390002",
  whbarTokenId: "0.0.15058",
  tokenIds: { HBAR: "0.0.0", USDC: "0.0.5449", SAUCE: "0.0.1183558" },
  feeTier: 3_000,
};

const ROUTER_ABI = [
  "function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function refundETH() payable",
  "function unwrapWHBAR(uint256 amountMinimum,address recipient) payable",
];

const QUOTER_ABI = [
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
];

const tokenAddress = (id: string): string => {
  if (id === "0.0.0") throw new Error("Native HBAR must be represented by configured WHBAR in a SaucerSwap route");
  return `0x${TokenId.fromString(id).toSolidityAddress()}`.toLowerCase();
};

const addressBytes = (address: string): number[] => Array.from(Buffer.from(address.slice(2), "hex"));
const feeBytes = (fee: number): number[] => [fee >> 16 & 0xff, fee >> 8 & 0xff, fee & 0xff];

/** Uniswap V3-compatible packed path: token(20) + fee(3) + token(20) ... */
export function encodeV2Path(routeTokenIds: readonly string[], feeTier: number): Uint8Array {
  if (routeTokenIds.length < 2) throw new Error("A swap route needs at least two tokens");
  if (!Number.isInteger(feeTier) || feeTier <= 0 || feeTier > 0xffffff) throw new Error("Invalid SaucerSwap fee tier");
  const result: number[] = [];
  routeTokenIds.forEach((id, index) => {
    result.push(...addressBytes(tokenAddress(id)));
    if (index < routeTokenIds.length - 1) result.push(...feeBytes(feeTier));
  });
  return Uint8Array.from(result);
}

export function minimumOutput(expected: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new Error("Slippage must be between 0 and 9999 bps");
  if (expected < 0n) throw new Error("Expected output cannot be negative");
  return expected * BigInt(10_000 - slippageBps) / 10_000n;
}

/** ECDSA Hedera accounts must use their actual EVM alias as a token recipient.
 * A numeric long-zero address is not interchangeable and can revert with
 * INVALID_ALIAS_KEY during an HTS transfer. */
export async function resolveAccountEvmAddress(
  accountId: string,
  options: { mirrorBaseUrl?: string; fetchFn?: typeof fetch } = {},
): Promise<string> {
  const base = (options.mirrorBaseUrl ?? "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");
  const response = await (options.fetchFn ?? fetch)(`${base}/api/v1/accounts/${encodeURIComponent(accountId)}`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Unable to resolve account EVM address (HTTP ${response.status})`);
  const body = await response.json() as { evm_address?: string };
  if (!body.evm_address || !/^0x[0-9a-fA-F]{40}$/.test(body.evm_address)) throw new Error("Mirror Node returned no valid account EVM address");
  return body.evm_address.toLowerCase();
}

export function resolveSaucerRoute(fromSymbol: string, toSymbol: string, config: SaucerSwapConfig = DEFAULT_SAUCERSWAP_TESTNET): string[] {
  const normalise = (symbol: string) => symbol.toUpperCase() as keyof SaucerSwapConfig["tokenIds"];
  const from = normalise(fromSymbol); const to = normalise(toSymbol);
  if (!config.tokenIds[from] || !config.tokenIds[to] || from === to) throw new Error("Unsupported SaucerSwap route");
  const actual = (symbol: keyof SaucerSwapConfig["tokenIds"]) => symbol === "HBAR" ? config.whbarTokenId : config.tokenIds[symbol];
  // USDC/SAUCE is intentionally constrained through WHBAR; direct pools can be
  // enabled only by adding an explicit route policy later.
  return from !== "HBAR" && to !== "HBAR" ? [actual(from), config.whbarTokenId, actual(to)] : [actual(from), actual(to)];
}

export function buildExactInputTransaction(input: {
  quote: SwapQuote;
  recipientSolidityAddress: string;
  slippageBps: number;
  config?: SaucerSwapConfig;
  nowSeconds?: number;
  ttlSeconds?: number;
}): BuiltSwapTransaction {
  const config = input.config ?? DEFAULT_SAUCERSWAP_TESTNET;
  const route = input.quote.route.length ? input.quote.route : resolveSaucerRoute(input.quote.fromSymbol, input.quote.toSymbol, config);
  const deadline = (input.nowSeconds ?? Math.floor(Date.now() / 1000)) + (input.ttlSeconds ?? 60);
  const amountOutMinimum = minimumOutput(input.quote.expectedAmountOut, input.slippageBps);
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.recipientSolidityAddress)) throw new Error("Recipient must be a Solidity address");
  const router = new Interface(ROUTER_ABI);
  const path = hexlify(encodeV2Path(route, config.feeTier));
  const fromHbar = input.quote.fromSymbol.toUpperCase() === "HBAR";
  const toHbar = input.quote.toSymbol.toUpperCase() === "HBAR";
  const routerAddress = `0x${ContractId.fromString(config.routerId).toSolidityAddress()}`;
  const swap = router.encodeFunctionData("exactInput", [[
    path,
    toHbar ? routerAddress : input.recipientSolidityAddress.toLowerCase(),
    BigInt(deadline),
    input.quote.amountIn,
    amountOutMinimum,
  ]]);
  let functionName: BuiltSwapTransaction["functionName"] = "exactInput";
  let encoded = swap;
  if (fromHbar) {
    functionName = "multicall";
    encoded = router.encodeFunctionData("multicall", [[swap, router.encodeFunctionData("refundETH")]]);
  } else if (toHbar) {
    functionName = "multicall";
    encoded = router.encodeFunctionData("multicall", [[
      swap,
      router.encodeFunctionData("unwrapWHBAR", [amountOutMinimum, input.recipientSolidityAddress.toLowerCase()]),
    ]]);
  }
  return {
    contractId: ContractId.fromString(config.routerId).toString(), functionName,
    encodedParameters: getBytes(encoded), amountTinybar: fromHbar ? input.quote.amountIn : 0n,
    deadline, amountOutMinimum, route,
  };
}

export interface ExactInputQuoteRequest {
  route: string[];
  amountIn: bigint;
}

/** Adapter seam for a Hedera ContractCallQuery / JSON-RPC eth_call implementation. */
export type ExactInputQuoter = (request: ExactInputQuoteRequest) => Promise<{ amountOut: bigint; gasEstimate?: bigint }>;

/** Calls QuoterV2 through Hedera Mirror Node's read-only contract endpoint. */
export function createMirrorExactInputQuoter(options: {
  mirrorBaseUrl?: string;
  config?: SaucerSwapConfig;
  fetchFn?: typeof fetch;
} = {}): ExactInputQuoter {
  const config = options.config ?? DEFAULT_SAUCERSWAP_TESTNET;
  const mirrorBaseUrl = (options.mirrorBaseUrl ?? "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");
  const fetchFn = options.fetchFn ?? fetch;
  const quoter = new Interface(QUOTER_ABI);
  return async ({ route, amountIn }) => {
    const data = quoter.encodeFunctionData("quoteExactInput", [hexlify(encodeV2Path(route, config.feeTier)), amountIn]);
    const response = await fetchFn(`${mirrorBaseUrl}/api/v1/contracts/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        block: "latest",
        data,
        to: `0x${ContractId.fromString(config.quoterId).toSolidityAddress()}`,
        gas: 2_000_000,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`SaucerSwap quoter HTTP ${response.status}`);
    const payload = await response.json() as { result?: string; error?: string };
    if (!payload.result) throw new Error(payload.error ?? "SaucerSwap quoter returned no result");
    const decoded = quoter.decodeFunctionResult("quoteExactInput", payload.result);
    return { amountOut: BigInt(decoded[0].toString()), gasEstimate: BigInt(decoded[3].toString()) };
  };
}

export async function quoteSaucerExactInput(input: {
  fromSymbol: string;
  toSymbol: string;
  amountIn: bigint;
  amountInFormatted: number;
  expectedAmountOutFormatted: number;
  quoter: ExactInputQuoter;
  config?: SaucerSwapConfig;
}): Promise<SwapQuote> {
  if (input.amountIn <= 0n) throw new Error("Swap input must be positive");
  const config = input.config ?? DEFAULT_SAUCERSWAP_TESTNET;
  const route = resolveSaucerRoute(input.fromSymbol, input.toSymbol, config);
  const response = await input.quoter({ route, amountIn: input.amountIn });
  if (response.amountOut <= 0n) throw new Error("SaucerSwap quoter returned no output");
  return {
    fromToken: input.fromSymbol.toUpperCase() === "HBAR" ? "0.0.0" : config.tokenIds[input.fromSymbol.toUpperCase() as "USDC" | "SAUCE"],
    fromSymbol: input.fromSymbol.toUpperCase(), toToken: input.toSymbol.toUpperCase() === "HBAR" ? "0.0.0" : config.tokenIds[input.toSymbol.toUpperCase() as "USDC" | "SAUCE"],
    toSymbol: input.toSymbol.toUpperCase(), amountIn: input.amountIn, amountInFormatted: input.amountInFormatted,
    expectedAmountOut: response.amountOut, expectedAmountOutFormatted: input.expectedAmountOutFormatted,
    route, quotedAt: new Date().toISOString(), provenance: "live",
  };
}
