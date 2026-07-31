# Dino Agent — multi-asset intelligence on Hedera

Dino Agent is a working autonomous portfolio manager built on x402 v2, Hedera testnet, and
SaucerSwap V2. Each cycle reads the configured Hedera account, purchases live intelligence
for HBAR, USDC, and SAUCE through three independently settled x402 requests, values the
managed portfolio, evaluates allocation bands, obtains an executable on-chain quote, and
either opens an approval gate or submits the bounded trade when autonomous execution is
explicitly enabled.

“Managing the portfolio” here means: **watch holdings → buy fresh prices when needed → explain what changed → decide whether to hold or rebalance** (and only then trade, if your mode allows it).

The provided Dino Agent UI is retained as the visual foundation; its demo arrays, random
activity, and browser-only state have been replaced with the versioned API and durable SSE
event stream. Fallback market values remain visibly labelled and are prohibited from
authorizing a trade.

A healthy cycle may end with **no trade** — the agent still paid for data, judged the mix,
and chose to hold. Rebalancing is one possible outcome, not the only job.

## Implemented workflow

1. Mirror Node reads the real account balance and HTS token relationships.
2. The agent purchases HBAR, USDC, and SAUCE data through the existing x402 payer
   (skipped in observe-only mode).
3. Settlement receipts and HashScan links are persisted in SQLite before being streamed.
4. Allocation bands deterministically select at most one rebalance candidate (or hold).
5. The order is capped by the 5% portfolio policy and 10 HBAR atomic limit.
6. SaucerSwap QuoterV2 is called through Hedera's read-only contract endpoint.
7. Live provenance, quote age, route, slippage, impact, balance, daily volume, and kill-switch
   rules must all pass.
8. Mode 3 persists a ten-minute approval proposal (your connected wallet signs). Mode 4 signs
   only with the dedicated agent account and verifies the resulting Hedera transaction before
   reporting success. After a verified swap, live balances are re-read and the portfolio mix
   is refreshed in the UI.

No plain HBAR transfer is used as a substitute for a swap, and no mock quote is accepted by
the trade policy.

### Autonomy modes

| Mode | Buys market data? | Trades? |
|---|---|---|
| 1 · Observe only | No | No |
| 2 · Advise only | Yes | No — recommendation only |
| 3 · Propose and wait | Yes | Only after you approve in wallet |
| 4 · Autonomous within limits | Yes | Yes, from the agent treasury |

Custody is chosen on `/connect` first (your wallet vs agent treasury). Switching between those
paths is a re-onboard, because each uses a different account.

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

The same root `.env` credentials (`HEDERA_CLIENT_ID` / `HEDERA_CLIENT_KEY`) are used for:

1. **x402 data purchases** — signed inside the API process (or via `x402-sign.ts` for CLI).
2. **Mode 4 swaps** — signed by the server with that dedicated agent account.
3. **Mode 3 swaps** — signed in the browser wallet instead; the server key is not used.

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

### System overview

![System architecture](docs/diagrams/architecture.png)

### One check-in

![Check-in workflow](docs/diagrams/workflow.png)

### Onboarding and modes

![Onboarding flow](docs/diagrams/onboarding.png)

<details>
<summary>Mermaid sources (editable)</summary>

Diagram sources live next to the PNGs in [`docs/diagrams/`](docs/diagrams/).

</details>

### Code map

- `src/core/provider.ts` — the `DataProvider` contract (the deliverable).
- `src/providers/mock/` — deterministic `MockDataProvider`.
- `src/providers/market/` — live CoinGecko-backed provider with a labeled resilient fallback.
- `src/agent/` — single-asset x402 buyer plus multi-asset portfolio orchestration.
- `src/portfolio/` — live Mirror Node holdings and deterministic allocation-band logic.
- `src/trading/` — SaucerSwap route/quote/calldata, policy, execution, and verification.
- `src/store/` — SQLite WAL projection, append-only event log, recovery, and leases.
- `src/scheduler/` — persisted cadence, daily budget enforcement, and single-run lease.
- `src/server/` — Hono app: pre-validation → `paymentMiddleware` → handler.
- `scripts/e2e-pay.ts` — live `402 → sign → settle → 200` verification with HashScan and mirror-node proof.
- `web/` — the production-wired Dino Agent UI and Playwright browser suite.

Swap data source: one line in `src/providers/index.ts`.
Swap facilitator: change `FACILITATOR_URL`.

```text
marketrail-x402/
├── README.md
├── package.json
├── .env.example
├── docs/diagrams/          ← architecture PNGs + Mermaid sources
├── docs/SUBMISSION_CHECKLIST.md
├── scripts/
│   ├── e2e-pay.ts
│   ├── preflight.ts
│   ├── x402-sign.ts
│   └── create-receiver.ts
├── src/
│   ├── agent/
│   ├── core/
│   ├── portfolio/
│   ├── providers/{market,mock}/
│   ├── trading/
│   ├── store/
│   ├── scheduler/
│   └── server/
├── test/
└── web/
```

## Setup

This is an npm workspace (root = API server, `web/` = Astro workbench). Run everything from the
repo root. Requires Node.js ≥20 (npm bundled).

1. `npm ci` — installs the locked root and web dependencies.
2. Copy `.env.example` to `.env`.
3. Set `HEDERA_CLIENT_ID` / `HEDERA_CLIENT_KEY` to a funded ECDSA testnet payer.
4. Set `PAY_TO_ACCOUNT` to a **different** Hedera testnet account. To create a distinct
   receiver controlled by the same ECDSA key, run `npx tsx scripts/create-receiver.ts` and
   copy the printed account ID. The script never prints a private key.
5. Keep `SIGNER_MAX_AMOUNT_ATOMIC=5000000` to allow the most expensive catalog product
   (0.05 HBAR) while rejecting larger challenges. Keep `SIGNER_ALLOWED_ORIGIN` /
   `SERVER_URL` aligned with how you call the API (`http://localhost:4021` by default).
6. Optional: add `MISTRAL_API_KEY` only if using the model-backed planner; it stays server-side.
7. For wallet-approval mode, copy `web/.env.example` → `web/.env` and set
   `PUBLIC_REOWN_PROJECT_ID`.

The dedicated agent account is the custody boundary for both x402 purchases and optional
autonomous swaps. Keep it funded only with test assets appropriate for the configured caps.
On `/connect`, pick wallet approval or autonomous treasury explicitly.

### SaucerSwap access

No public or private SaucerSwap API key is needed for the implemented trade path. Quotes are
read directly from testnet QuoterV2 and swaps are submitted directly to the Router contract.
The public REST service is therefore not a production dependency. If a later feature needs
SaucerSwap's hosted analytics or token metadata at sustained volume, request a supported key
from their team and keep it server-side; do not embed a shared public key in the browser.

Credentials pasted into chats, issues, logs, or screenshots must be rotated before use.

### API server

```bash
npm run dev      # hot reload on http://localhost:4021
npm start        # run once, no watch
npm test         # offline contract/unit tests
npm run e2e      # real paid request through Blocky402 + mirror verification
npm run preflight
```

- `POST /api/agent/run` — run the agent flow and return a redacted protocol trace.
- `GET /api/health` — provider and agent readiness without exposing credentials.
- `GET /api/v1/profiles` — custody profiles and current autonomy/schedule state.
- `POST /api/v1/profiles/:id/runs` — concurrency-safe multi-asset cycle.
- `GET /api/v1/profiles/:id/stream` — durable SSE replay and live lifecycle events.
- `GET /api/v1/profiles/:id/proposals` — fresh approval-gated SaucerSwap orders.
- `POST /api/v1/proposals/:id/approve|reject` — evaluate a pending order exactly once.
- `POST /api/v1/proposals/:id/confirm` — confirm a wallet-signed swap.
- `PATCH /api/v1/profiles/:id/schedule` — cadence, pause, and autonomy settings.
- `POST /api/v1/system/halt|resume` — global kill switch.

### Web (live agent workbench)

```bash
npm run web:dev                         # http://localhost:4321
npm run web:build && npm run web:preview
npm run web:typecheck
npm run test -w web
npm run test:e2e -w web
```

For a non-default API port, start Astro with `API_PROXY_TARGET=http://127.0.0.1:PORT`.
If you call the signer CLI against `127.0.0.1`, also set `SIGNER_ALLOWED_ORIGIN` to that same
origin — the fail-closed policy rejects mismatched hosts.

## Persistence and safety

Runtime state is stored in `data/agent.sqlite` with WAL journaling. Runs, proposals, spend,
profiles, mandates, system halt state, and SSE events survive restart. A run interrupted by a
process restart is marked failed rather than resubmitted. Scheduler leases prevent overlapping
manual and scheduled runs on the single-host deployment. Secrets and SQLite runtime files are
ignored by git.

## Catalog

| product | params | price |
|---|---|---|
| `spot-price` | `symbol` | 0.01 HBAR |
| `quote` | `symbol` | 0.02 HBAR |
| `ohlc` | `symbol`, `date` | 0.05 HBAR |

`GET /catalog` returns the live catalog. The payment outcome is read from the `payment-response`
header (base64 JSON), and the Hedera transaction id is carried in its `transaction` field.

CoinGecko supplies the upstream numbers. This server is the Hedera x402 paywall: unpaid calls
return HTTP 402; after settlement the shop fetches CoinGecko and unlocks the payload.

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
Use the same host as `SERVER_URL` / `SIGNER_ALLOWED_ORIGIN` (default `http://localhost:4021`).

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

- [Submission checklist](docs/SUBMISSION_CHECKLIST.md) — release, secret, and HashScan proof checks.
- [MIT license](LICENSE) — this repository is open source.

### Verified Hedera testnet proof

| flow | product | amount | transaction |
|---|---|---:|---|
| Multi-asset cycle | HBAR intelligence | 0.01 HBAR | [HashScan](https://hashscan.io/testnet/transaction/0.0.7162784-1785493884-281733761) |
| Multi-asset cycle | USDC intelligence | 0.01 HBAR | [HashScan](https://hashscan.io/testnet/transaction/0.0.7162784-1785493890-941770239) |
| Multi-asset cycle | SAUCE intelligence | 0.01 HBAR | [HashScan](https://hashscan.io/testnet/transaction/0.0.7162784-1785493898-759696230) |
| Approval-gated SaucerSwap V2 trade | 10 HBAR → 13.410262 USDC | bounded by 1% slippage | [HashScan](https://hashscan.io/testnet/transaction/0.0.6255888-1785493939-647708643) |
| Browser portfolio agent (Mistral plan + analysis) | `quote?symbol=HBAR` | 0.02 HBAR | [HashScan](https://hashscan.io/testnet/transaction/0.0.7162784-1785458285-103875125) |
| CLI protocol acceptance test | `spot-price?symbol=HBAR` | 0.01 HBAR | [HashScan](https://hashscan.io/testnet/transaction/0.0.7162784-1785457946-390016878) |

The x402 transfers were checked through Hedera's testnet mirror API for `SUCCESS`, with payer
`0.0.6255888` debited and receiver `0.0.9848501` credited by the exact catalog price. The swap
proof additionally verifies that account `0.0.6255888` received at least the Router order's
minimum USDC output across the transaction's child records. Run `npm run e2e` to generate and
verify a fresh x402 proof before recording.

## Known limitations

- The public CoinGecko feed is not investment-grade and can rate-limit; fallback values are
  deterministic and returned with `isLive: false`. A cycle may display them, but policy blocks
  every associated trade.
- `freshnessWindowSec` is in the contract but not enforced (clean pay-per-call).
- The hosted testnet facilitator is an external availability and rate-limit dependency.
- Local `.env` key custody is suitable for a testnet demo, not production funds.
- User-wallet Mode 3 needs `PUBLIC_REOWN_PROJECT_ID` and a WalletConnect session; without it,
  approve-in-wallet cannot prompt. The dedicated agent profile (Mode 4) is the fully working
  end-to-end path out of the box.
- This implementation is intentionally single-host. Horizontal deployment needs a shared job
  queue/lease backend and managed SQL rather than the local SQLite scheduler lease.
- No HCS attestation is included in this version; settlement proof is the Hedera transaction.
