# Demo runbook

Technical rehearsal for an under-five-minute recording.
For the **spoken script**, use **[DEMO_SCRIPT.md](DEMO_SCRIPT.md)**.

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

7. Run `npm test` and `npm run web:build`.

## Recording flow

Start the API in terminal one:

```bash
npm start
```

Start the web experience in terminal two:

```bash
npm run web:dev
```

Open http://localhost:4321/connect → choose **autonomous** (Mode 4) or approval mode →
workspace → follow **[DEMO_SCRIPT.md](DEMO_SCRIPT.md)**.

Optional protocol-only proof in terminal three:

```bash
npm run e2e
```

The command must show all six stages, a successful settlement transaction, a
HashScan link, and `MIRROR_VERIFIED result=SUCCESS`.

## Recovery notes

- `429` from Blocky402: wait for the per-IP testnet rate window and retry once.
- `INSUFFICIENT_PAYER_BALANCE`: refill the payer in Hedera Portal.
- Policy rejection: compare `SERVER_URL`, `PAY_TO_ACCOUNT`, the asset, and amount cap.
- Mirror lookup lag: settlement is final first; the script polls indexing for about 15 seconds.
- Expired payload: sign immediately before retry; the server uses a 180-second timeout.
- No trade this cycle: still show paid unlocks + HashScan; bands may already be healthy.
- Never switch to a browser-embedded private key to save a demo.
