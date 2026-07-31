# Demo runbook

This is the shortest reliable path for an under-five-minute bounty demo. Use a
fresh terminal and rehearse it once before recording.

## Before recording

1. Use a fresh, funded ECDSA Hedera testnet payer. Never paste its key into a
   prompt, commit, browser bundle, screenshot, or shell argument.
2. Use a different account ID for `PAY_TO_ACCOUNT`. To create one controlled by
   the same key without printing another key, run:

   ```bash
   npx tsx scripts/create-receiver.ts
   ```

3. Copy `.env.example` to `.env`, fill the payer and receiver placeholders, and
   leave the policy cap at `5000000` tinybars (0.05 HBAR) for the three demo products.
4. Run `npm run preflight`. Do not record until every external dependency reports `PASS`.
5. Keep `DATA_PROVIDER=market` for live CoinGecko data. The response includes
   `isLive` and `source`; if the public feed is unavailable, the labeled deterministic
   fallback keeps the payment demo recoverable without presenting stale data as live.
6. If diagnosing manually, confirm the public facilitator advertises x402 v2 Hedera testnet support:

   ```bash
   curl -fsS https://api.testnet.blocky402.com/supported
   ```

7. Run `npm test`, `npm run typecheck`, and `npm run web:build`.

## Recording flow

Start the API in terminal one:

```bash
npm start
```

Start the web experience in terminal two:

```bash
npm run web:dev
```

In terminal three, run the paid agent flow:

```bash
npm run e2e
```

The command must show all six stages, a successful settlement transaction, a
HashScan link, and `MIRROR_VERIFIED result=SUCCESS`. Treat any missing stage as
a failed rehearsal, even if the data response looks correct.

## Suggested narration

1. **Problem (20s):** Agents should buy one market-data query instead of holding
   a subscription and API key.
2. **Catalog (25s):** Show the three products and their tiny HBAR prices.
3. **Protocol (60s):** Run the command and point out the unpaid request, HTTP
   402 terms, local policy approval, signature, Hedera settlement, and HTTP 200 data.
4. **Proof (45s):** Open the generated HashScan link. Show `SUCCESS`, payer debit,
   receiver credit, amount, and timestamp. The transaction ID belongs to the
   facilitator fee payer; the transfer list proves the buyer and seller legs.
5. **Agent safety (35s):** Show the configured origin, payee, asset, network, and
   maximum amount. The signing tool refuses any challenge outside that scope.
6. **Architecture (45s):** Show the swappable `DataProvider`, x402 middleware,
   Blocky402 facilitator, and Hedera rail.
7. **Close (15s):** Every query has an explicit price, machine-readable result,
   and independently verifiable on-chain receipt.

## Recovery notes

- `429` from Blocky402: wait for the per-IP testnet rate window and retry once.
- `INSUFFICIENT_PAYER_BALANCE`: refill the payer in Hedera Portal.
- Policy rejection: compare `SERVER_URL`, `PAY_TO_ACCOUNT`, the asset, and amount cap.
- Mirror lookup lag: settlement is final first; the script polls indexing for about 15 seconds.
- Expired payload: sign immediately before retry; the server uses a 180-second timeout.
- Never switch to a browser-embedded private key to save a demo. Keep the paid
  flow in the local agent process.
