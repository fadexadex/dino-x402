# Submission checklist

## Required artifacts

- [ ] Public GitHub repository under the submitter's account
- [ ] MIT `LICENSE` visible at repository root
- [ ] README setup works from a clean clone with Node.js 20+
- [ ] Demo video is under five minutes and shows the complete paid flow
- [ ] At least one successful Hedera testnet HashScan link is recorded
- [ ] Submission form is completed before the published deadline

## Release verification

- [ ] `npm ci`
- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run web:typecheck`
- [ ] `npm run web:build`
- [ ] Unpaid valid resource returns HTTP 402 with x402 v2 requirements
- [ ] Unknown product and missing parameters fail before payment
- [ ] Paid retry returns HTTP 200 and a successful `payment-response`
- [ ] Mirror node reports `SUCCESS`, exact payer debit, and exact receiver credit
- [ ] Same payment payload cannot be settled twice
- [ ] Excess amount, wrong origin, asset, network, or payee is rejected before signing

## Secret hygiene

- [ ] Rotate every credential ever pasted into chat, an issue, a log, or a screenshot
- [ ] `.env` remains ignored and untracked
- [ ] `git grep` finds no live API keys or private-key literals
- [ ] Full Git history is scanned with Gitleaks or TruffleHog before publishing
- [ ] Built `dist/` and `web/dist/` contain no secret or private-key material
- [ ] AI-provider keys, if used, are server-only and are never exposed to browser code

Suggested checks:

```bash
git ls-files .env
git grep -nEi '(api[_-]?key|private[_-]?key)[=:][[:space:]]*[^$<{[:space:]]+'
gitleaks git --redact
```

## HashScan evidence

For each showcased transaction, save:

- HashScan testnet URL
- Native settlement transaction ID from `payment-response`
- product and price
- payer account ID
- receiver account ID
- recording timestamp

HashScan uses the hyphenated transaction form:
`0.0.<fee-payer>-<seconds>-<nanoseconds>`.
