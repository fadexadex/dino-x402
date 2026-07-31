# MarketRail — x402 market data on Hedera

MarketRail is a working pay-per-query financial-data reference built on x402 v2 and Hedera
testnet. An agent requests a product, receives HTTP 402 payment terms, signs within a strict
spend policy, settles HBAR through the Blocky402 facilitator, and receives machine-readable
data plus an on-chain transaction proof.

The default `MarketDataProvider` buys live CoinGecko pricing for HBAR, BTC, ETH, SOL, and
USDC, with an explicitly labeled deterministic fallback if the public feed is unavailable.
The `DataProvider` interface is swappable without changing the payment flow. The resource
server holds no Hedera key.

## Paying with an agent

An AI agent can buy a resource autonomously while the payer key stays in the server-side
signing process. Two ways:

- **Inside this repo** — use `scripts/x402-sign.ts` directly; see
  [Paying as an agent (delegated signing)](#paying-as-an-agent-delegated-signing)
  for the manual `402 → sign → 200` flow.
- **From anywhere** — use the Hiero CLI via the `hedera-skills` skill; see
  [Paying via the Hiero CLI skill](#paying-via-the-hiero-cli-skill).

The local signer is fail-closed: it checks x402 version, resource origin, network, asset,
receiver, and maximum atomic amount before creating a payment. No private key or payment
signature is returned by the agent API.

> Planned: move the byte-signing step to the Hiero CLI so signing runs fully securely,
> replacing the local key in `.env`.

### Paying via the Hiero CLI skill

For the Hiero CLI route, install the [`hedera-skills`](https://github.com/hedera-dev/hedera-skills)
skill from Hedera. It ships x402 support and documents how the agent should pay — so with it
installed an agent can run the buy flow through the Hiero CLI instead of the local signer.

> **Disclaimer:** the skill supplies the x402 capability and instructions, but the actual flow
> is driven by the agent. How reliably it works depends on the knowledge the agent is given —
> via its system prompt, the skill itself, or other context. Treat the skill as the tool, not
> the guarantee: a well-briefed agent pays smoothly, an under-briefed one may not.

## Architecture

- `src/core/provider.ts` — the `DataProvider` contract (the deliverable).
- `src/providers/mock/` — deterministic `MockDataProvider`.
- `src/providers/market/` — live CoinGecko-backed provider with a labeled resilient fallback.
- `src/agent/` — agent decision, payment execution, and redacted trace.
- `src/server/` — Hono app: pre-validation → `paymentMiddleware` → handler.
- `scripts/e2e-pay.ts` — live `402 → sign → settle → 200` verification with HashScan and mirror-node proof.
- `web/` — light financial UI and live agent workbench.

Swap data source: one line in `src/providers/index.ts`.
Swap facilitator: change `FACILITATOR_URL`.

## Setup

This is an npm workspace (root = API server, `web/` = Astro landing). Run everything from the repo root. Requires Node.js ≥20 (npm bundled).

1. `npm ci` — installs the locked root and web dependencies.
2. Copy `.env.example` to `.env`.
3. Set `HEDERA_CLIENT_ID` / `HEDERA_CLIENT_KEY` to a funded ECDSA testnet payer.
4. Set `PAY_TO_ACCOUNT` to a **different** Hedera testnet account. To create a distinct
   receiver controlled by the same ECDSA key, run `npx tsx scripts/create-receiver.ts` and
   copy the printed account ID. The script never prints a private key.
5. Keep `SIGNER_MAX_AMOUNT_ATOMIC=5000000` to allow the most expensive demo product
   (0.05 HBAR) while rejecting larger challenges. Add `MISTRAL_API_KEY` only if using the
   optional model-backed agent decision; it stays server-side.

Credentials pasted into chats, issues, logs, or screenshots must be rotated before use.

### API server
- `npm run dev` — start the server with hot reload on `http://localhost:4021`.
- `npm start` — run once, no watch.
- `npm test` — offline contract/unit tests.
- `npm run e2e` — real paid request through Blocky402, followed by mirror-node verification.
- `npm run preflight` — verify the facilitator, Hedera accounts, live data feed, and Mistral model before recording.
- `POST /api/agent/run` — run the agent flow and return a redacted protocol trace.
- `GET /api/health` — provider and agent readiness without exposing credentials.

### Web (live agent workbench + docs)
- `npm run web:dev` — live workbench and landing page; also serves `llms.txt` for agents.
- `npm run web:build && npm run web:preview` — preview the production build.
- `npm run web:typecheck` — Astro type check.

## Catalog

| product | params | price |
|---|---|---|
| `spot-price` | `symbol` | 0.01 HBAR |
| `quote` | `symbol` | 0.02 HBAR |
| `ohlc` | `symbol`, `date` | 0.05 HBAR |

`GET /catalog` returns the live catalog. The payment outcome is read from the `payment-response` header (base64 JSON), and the Hedera transaction id is carried in its `transaction` field.

## Paying as an agent (delegated signing)

`scripts/x402-sign.ts` is a standalone signer so an agent can drive the payment over plain
HTTP while the private key stays in a separate local process. The agent runs the HTTP flow;
the script validates the challenge against the configured policy and only then signs.

- **stdin** ← value of the `payment-required` header from the 402 response
- **stdout** → value of the `payment-signature` header to retry with

The key is read from `.env` and never written to stdout, argv, or application logs. The
signed payload is intentionally returned to complete x402. For stronger custody, replace
the local signer with an HSM/KMS or Hiero CLI signer; the HTTP flow remains the same.

Requires a funded ECDSA testnet account in `.env` (`HEDERA_CLIENT_ID`, `HEDERA_CLIENT_KEY`).

```bash
URL="http://localhost:4021/data/spot-price?symbol=HBAR"

# 1. Trigger the 402 and capture the payment-required header
PR=$(curl -s -D - -o /dev/null "$URL" \
  | grep -i '^payment-required:' | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r')

# 2. Delegate signing (key stays in the script)
SIG=$(printf '%s' "$PR" | npx tsx scripts/x402-sign.ts)

# 3. Retry with the signature: 200 + data, settlement in the payment-response header
curl -s -i "$URL" -H "payment-signature: $SIG"
```

The signed payload expires after `maxTimeoutSeconds` (180s), so sign immediately before
the retry. The reference scripts expect an ECDSA account.

## Demo and submission

- [Demo runbook](docs/DEMO.md) — rehearsable under-five-minute flow and recovery notes.
- [Submission checklist](docs/SUBMISSION_CHECKLIST.md) — release, secret, and HashScan proof checks.
- [MIT license](LICENSE) — this repository is open source.

### Verified Hedera testnet proof

| flow | product | amount | transaction |
|---|---|---:|---|
| Browser portfolio agent (Mistral plan + analysis) | `quote?symbol=HBAR` | 0.02 HBAR | [HashScan](https://hashscan.io/testnet/transaction/0.0.7162784-1785458285-103875125) |
| CLI protocol acceptance test | `spot-price?symbol=HBAR` | 0.01 HBAR | [HashScan](https://hashscan.io/testnet/transaction/0.0.7162784-1785457946-390016878) |

Both transactions were independently checked through Hedera's testnet mirror API for
`SUCCESS`, with payer `0.0.6255888` debited and receiver `0.0.9848501` credited by the exact
catalog price. Run `npm run e2e` to generate and verify a fresh proof before recording.

## Known limitations

- The public CoinGecko feed is not investment-grade and can rate-limit; fallback values are
  deterministic and returned with `isLive: false` so an agent cannot mistake them for live data.
- `freshnessWindowSec` is in the contract but not enforced (clean pay-per-call).
- The hosted testnet facilitator is an external availability and rate-limit dependency.
- Local `.env` key custody is suitable for a testnet demo, not production funds.
- No HCS attestation is included in this version; settlement proof is the Hedera transaction.
