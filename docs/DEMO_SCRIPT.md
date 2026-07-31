# Demo script (spoken)

Use this as a teleprompter while you record. Target length: **about 4 minutes**.
Keep HashScan tabs open before you press record.

Suggested on-screen path:

1. `/connect` — custody choice  
2. Workspace — Mode 4 autonomous agent  
3. One live check-in (pay → think → maybe swap → portfolio refresh)  
4. Graph + one HashScan receipt  

---

## 0. Before you hit record (30 seconds, off-camera)

- API running: `npm start`  
- UI running: `npm run web:dev`  
- Mode 4 already enabled on a funded agent treasury  
- Browser zoom comfortable; Graph panel open on the right  

---

## 1. Opening (20–25 seconds)

> Hi — this is **Dino Agent**, built for the Hedera x402 bounty.
>
> The problem is simple: an AI agent that manages a portfolio should buy **only the market data it needs**, when it needs it — not hold a yearly API subscription.
>
> x402 turns “Payment Required” into a real pay-per-call standard. We settle those tiny payments on **Hedera testnet**, then the agent can act on what it learned.

*(Show the workbench with portfolio balances visible.)*

---

## 2. What you are looking at (20 seconds)

> On the left is the live portfolio — HBAR, USDC, and SAUCE — valued in dollars.
>
> In the center is the activity stream: every step the agent takes, in plain language.
>
> On the right is the graph of prices the agent **paid** to unlock — not free scrapes, paid reads.

*(Point briefly at each column.)*

---

## 3. How money custody works (25–30 seconds)

*(Optional cut to `/connect` if you want judges to see onboarding.)*

> Setup starts with one clear choice:
>
> - **I approve each trade** — connect your own wallet; nothing moves until you confirm in the wallet app.
> - **Let the agent run on its own** — fund a server-managed treasury; the agent trades inside your limits.
>
> That choice is made up front, not mid-chat, because each path uses a different account.

*(Return to the workspace in Mode 4.)*

---

## 4. Start a check-in (15 seconds)

> I’ll ask the agent to run a portfolio check-in: buy fresh prices, explain what it sees, and rebalance only if the mix is outside the target bands.

*(Type a short objective, e.g.:)*

> “Buy fresh prices for HBAR, USDC, and SAUCE. If HBAR is over its ceiling, rebalance and refresh the portfolio.”

*(Press Send.)*

---

## 5. Paying for market data (45–60 seconds) — this is the bounty core

> Watch the stream.
>
> First the agent reads live balances from Hedera.
>
> Then it tries to buy a price. The market-data shop answers with **Payment Required** — that is HTTP 402 / x402.
>
> The agent pays a tiny amount of **testnet HBAR**. You can see each unlock in the stream — HBAR, then USDC, then SAUCE — each with its own on-chain receipt.
>
> After payment settles, the shop fetches a live CoinGecko price and unlocks it for the agent.
>
> Important: CoinGecko is the **upstream data**. The product we built is the **paywall on Hedera rails**. That matches the bounty’s “agent pays per query” reference architecture.

*(When a payment unlocks, click “See this moment on the graph” or point at a green marker.)*

---

## 6. Agent thoughts (20–25 seconds)

> While this runs, the agent narrates in plain language — not Quoter jargon.
>
> You’ll see things like: holdings are in, prices arrived, this sleeve is over its ceiling, here’s the trade it wants.

*(Expand “Thought for Xs” if collapsed. Pause so viewers can read one insight.)*

---

## 7. Trade + portfolio refresh (40–50 seconds)

> If the mix needs a rebalance, Mode 4 submits a real SaucerSwap exchange on Hedera.
>
> You see: safety checks passed → exchange order sent → swap completed → **portfolio refreshed**.
>
> After the swap, balances and percentages update from live holdings — not a stale pre-trade snapshot.

*(Point at the portfolio rail as numbers move. Open the HashScan link on the swap card.)*

> Here is the HashScan proof: the payment or the swap settled on Hedera testnet.

---

## 8. Approval path (optional 20 seconds, if you have Mode 3 ready)

> If you chose “I approve each trade,” the agent stops with a proposal.
>
> You click **Approve in wallet**. Your connected wallet is prompted to sign. The server never signs user-wallet trades for you.

---

## 9. Close (15–20 seconds)

> To summarize:
>
> 1. Agent needs a price.  
> 2. It pays per call through x402 on Hedera.  
> 3. It unlocks real market data.  
> 4. It may rebalance on-chain.  
> 5. Everything is inspectable — stream, graph, HashScan.
>
> That’s Dino Agent: autonomous portfolio management with machine-to-machine payments on Hedera.

*(End on the conclusion card + HashScan tab.)*

---

## Timing cheat sheet

| Block | Time |
|---|---|
| Opening + UI tour | ~45s |
| Custody / Mode 4 | ~30s |
| Live check-in + payments | ~60s |
| Thoughts + trade + proof | ~70s |
| Close | ~20s |
| **Total** | **~3:45** |

## If something stalls

- **Waiting on payment:** give it ~10s; Blocky402 can be slow once. Narrate “settling the micropayment on Hedera.”
- **No trade this cycle:** say “bands are healthy — the important part is the paid reads,” then open a prior HashScan from the README table.
- **CoinGecko rate limit:** the UI labels fallback data; policy will not trade on fallback. Restart the check-in once.
