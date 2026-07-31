import { expect, test, type Page } from "@playwright/test";

type Call = { method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> };
type Event = { id: string; sequence: number; runId: string; kind: string; title: string; detail?: string; occurredAt: string; provenance: "live" | "cached" | "fallback" | "stale"; payload?: Record<string, unknown> };
type State = { profiles: Array<Record<string, unknown>>; events: Event[]; proposals: Array<Record<string, unknown>>; halted: boolean; schedule: { cadenceMinutes: number; paused: boolean; autonomyMode: 1 | 2 | 3 | 4 }; mandate: Record<string, unknown>; calls: Call[] };

const NOW = "2026-07-31T10:00:00.000Z";
const profile = { id: "agent-testnet", name: "Agent treasury", kind: "agent_managed", accountId: "0.0.55555", network: "hedera:testnet", autonomyMode: 4, status: "active", cadenceMinutes: 15 };

function stateWithProfile(): State {
  return {
    profiles: [{ ...profile }],
    events: [
      { id: "observed", sequence: 1, runId: "run-1", kind: "portfolio.observed", title: "Portfolio observed", detail: "Verified Hedera balances", occurredAt: NOW, provenance: "live" },
      { id: "payment", sequence: 2, runId: "run-1", kind: "payment.settled", title: "HBAR price intelligence settled", detail: "x402 payment verified", occurredAt: NOW, provenance: "live", payload: { transactionId: "0.0.1@123.0001" } },
      { id: "proposal-event", sequence: 3, runId: "run-1", kind: "trade.proposed", title: "Rebalance proposed", detail: "HBAR is above its target band", occurredAt: NOW, provenance: "live" },
    ],
    proposals: [{ id: "proposal-1", status: "pending", fromSymbol: "HBAR", toSymbol: "USDC", amount: "25", expectedOutput: "1.82 USDC", minimumOutput: "1.79 USDC", slippageBps: 100, reason: "HBAR is above its allocation band.", expiresAt: new Date(Date.now() + 600_000).toISOString() }],
    halted: false,
    schedule: { cadenceMinutes: 15, paused: false, autonomyMode: 4 },
    mandate: { objective: "Keep HBAR under 60%", limits: { maxPerTrade: 125, maxTradesPerDay: 3, maxPortfolioMovePct: 5, maxDailySpend: 2, allowList: ["HBAR", "USDC", "SAUCE"] } },
    calls: [],
  };
}

const portfolio = { asOf: NOW, totalUsd: "250.00", provenance: "live", assets: [{ symbol: "HBAR", balance: "1200", usdValue: "200", allocationPct: "80", provenance: "live" }, { symbol: "USDC", balance: "50", usdValue: "50", allocationPct: "20", provenance: "live" }, { symbol: "SAUCE", balance: "0", usdValue: "0", allocationPct: "0", provenance: "cached" }] };
const graph = { ticks: [{ t: Date.parse("2026-07-31T09:30:00.000Z"), price: 0.071, provenance: "live" }, { t: Date.parse(NOW), price: 0.073, provenance: "live" }], markers: [{ t: Date.parse(NOW), eventId: "payment" }] };
const receipts = [{ id: "receipt-1", kind: "data_purchase", runId: "run-1", occurredAt: NOW, status: "confirmed", symbol: "HBAR", productId: "spot-price", amountHbar: "0.001", transactionId: "0.0.1@123.0001", hashscanUrl: "https://hashscan.io/testnet/transaction/0.0.1@123.0001", provenance: "live" }];

async function installApi(page: Page, state: State, slow = false) {
  await page.addInitScript(() => {
    type Listener = (event: MessageEvent<string>) => void;
    const streams: Array<{ onmessage: Listener | null; listeners: Map<string, Listener[]> }> = [];
    class TestEventSource {
      onmessage: Listener | null = null;
      onerror: (() => void) | null = null;
      listeners = new Map<string, Listener[]>();
      constructor() { streams.push(this); }
      addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
      close() { streams.splice(streams.indexOf(this), 1); }
    }
    Object.defineProperty(window, "EventSource", { value: TestEventSource, configurable: true });
    (window as Window & { __agentStreamCount?: () => number }).__agentStreamCount = () => streams.length;
    (window as Window & { __emitAgentEvent?: (event: unknown) => void }).__emitAgentEvent = (event) => {
      const message = { data: JSON.stringify(event), lastEventId: String((event as { sequence?: number }).sequence ?? "") } as MessageEvent<string>;
      streams.forEach((stream) => stream.onmessage?.(message));
    };
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = `${url.pathname.replace("/api/v1", "")}${url.search}`;
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : {};
    state.calls.push({ method: request.method(), path, headers: request.headers(), body });
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (slow && path === "/profiles") await new Promise((resolve) => setTimeout(resolve, 300));
    if (request.method() === "GET" && path === "/profiles") return json(state.profiles);
    if (request.method() === "GET" && path.endsWith("/dashboard")) return json({ profile: { ...profile, ...state.profiles[0], status: state.halted ? "halted" : state.schedule.paused ? "paused" : "active" }, portfolio, events: state.events, pendingProposals: state.proposals, spend: { dataHbar: "0.001", dataTodayHbar: "0.001", tradeHbar: "0", tradeTodayHbar: "0", networkHbar: "0.0001" }, system: { halted: state.halted }, mandate: state.mandate, schedule: state.schedule, runs: [{ id: "run-1", status: "completed", objective: state.mandate.objective as string }] });
    if (request.method() === "GET" && path.endsWith("/graph?series=HBAR")) return json(graph);
    if (request.method() === "GET" && path.endsWith("/receipts")) return json({ receipts });
    if (request.method() === "POST" && path.endsWith("/runs")) { state.events.push({ id: "manual", sequence: state.events.length + 1, runId: "run-manual", kind: "run.triggered", title: "Manual check-in started", detail: "Server accepted the idempotent run.", occurredAt: NOW, provenance: "live" }); return json({ accepted: true }); }
    if (request.method() === "PATCH" && path.endsWith("/schedule")) { state.schedule = { ...state.schedule, ...body } as State["schedule"]; return json({ updated: true }); }
    if (request.method() === "PATCH" && path.endsWith("/mandate")) { state.mandate = { ...state.mandate, ...body, limits: state.mandate.limits }; return json({ updated: true }); }
    if (request.method() === "POST" && /^\/proposals\/[^/]+\/(approve|reject)$/.test(path)) { const approved = path.endsWith("approve"); state.proposals = []; state.events.push({ id: approved ? "approved" : "declined", sequence: state.events.length + 1, runId: "run-1", kind: approved ? "trade.approved" : "trade.rejected", title: approved ? "Trade approval recorded" : "Trade proposal declined", occurredAt: NOW, provenance: "live" }); return json({ accepted: true }); }
    if (request.method() === "POST" && path === "/system/halt") { state.halted = true; return json({ halted: true }); }
    if (request.method() === "POST" && path === "/system/resume") { state.halted = false; return json({ halted: false }); }
    return json({ error: `Unhandled test endpoint: ${request.method()} ${path}` }, 404);
  });
}

test("keeps empty and connect states honest when no authenticated profile exists", async ({ page }) => {
  await installApi(page, { ...stateWithProfile(), profiles: [] }, true);
  await page.goto("/");
  await expect(page.getByText("Connect an account to begin")).toBeVisible();
  await expect(page.getByRole("link", { name: "Pick a wallet" })).toBeVisible();
  await page.getByRole("link", { name: "Pick a wallet" }).click();
  await expect(page).toHaveURL(/\/connect$/);
  await expect(page.getByRole("heading", { name: /Connect an account to begin|How should the agent work/ })).toBeVisible();
  await expect(page.getByText(/WalletConnect is ready for Hedera testnet|WalletConnect is not enabled in this deployment/)).toBeVisible();
  const hashPack = page.getByRole("button", { name: "HashPack" });
  if (await hashPack.count()) {
    await expect(hashPack).toBeVisible();
    if (await hashPack.isEnabled()) {
      await expect(page.getByText("WalletConnect is ready for Hedera testnet")).toBeVisible();
    }
  }
});

test("uses the current dashboard, graph drawer, source receipt, modes, limits, schedule, composer, and SSE", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "The mobile project has its own layout smoke.");
  const state = stateWithProfile();
  await installApi(page, state);
  await page.goto("/");
  await expect(page.getByText("0.0.55555 · hedera:testnet").first()).toBeVisible();
  await expect(page.getByText("HBAR price intelligence settled").first()).toBeVisible();
  await expect(page.getByText("HBAR · spot-price")).toBeVisible();

  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(page.getByText("Only data the agent paid for is drawn.").first()).toBeVisible();
  await page.getByRole("button", { name: "Trace" }).click();
  await expect(page.getByText("Click any step in the stream, or a trade marker on the graph, to inspect it here.").first()).toBeVisible();
  await page.getByRole("button", { name: "Ledger" }).click();
  await expect(page.getByText("Data spend").first()).toBeVisible();
  await page.getByRole("button", { name: "Close inspector" }).last().click();

  for (const label of ["Observe only", "Advise only", "Propose and wait", "Autonomous within limits"]) await page.getByText(label, { exact: true }).click();
  await expect.poll(() => state.calls.filter((call) => call.path.endsWith("/schedule") && call.body.autonomyMode === 4).length).toBeGreaterThan(0);
  await page.locator('input[type="number"]').first().fill("150");
  await expect.poll(() => state.calls.filter((call) => call.path.endsWith("/mandate")).length).toBeGreaterThan(0);

  await page.getByRole("combobox", { name: "Agent run frequency" }).selectOption({ label: "every 30m" });
  await page.getByRole("button", { name: /Watching · next/ }).click();
  await expect(page.getByRole("button", { name: /Paused · next paused/ })).toBeVisible();
  await expect.poll(() => state.calls.filter((call) => call.path.endsWith("/schedule") && call.body.paused === true).length).toBeGreaterThan(0);

  await page.getByPlaceholder("Tell the agent what to watch, or type / for commands").fill("Keep USDC near target");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/runs")).length).toBeGreaterThan(0);
  const runCall = state.calls.find((call) => call.method === "POST" && call.path.endsWith("/runs"));
  expect(runCall?.headers["idempotency-key"]).toBeTruthy();
  expect(state.calls.some((call) => call.path.endsWith("/mandate") && call.body.objective === "Keep USDC near target")).toBeTruthy();

  await expect.poll(() => page.evaluate(() => (window as Window & { __agentStreamCount?: () => number }).__agentStreamCount?.() ?? 0)).toBeGreaterThan(0);
  await page.evaluate(() => (window as Window & { __emitAgentEvent?: (event: unknown) => void }).__emitAgentEvent?.({ id: "sse", sequence: 99, runId: "run-1", kind: "payment.settled", title: "SSE settlement received", occurredAt: "2026-07-31T10:00:00.000Z", provenance: "live" }));
  await expect(page.getByText("SSE settlement received").first()).toBeVisible();
});

test("approves and declines proposals through the real UI endpoints", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Avoids duplicating transactional UI coverage on mobile.");
  const approved = stateWithProfile();
  await installApi(page, approved);
  await page.goto("/");
  await page.getByRole("button", { name: "Approve and execute" }).click();
  await expect(page.getByText("Trade approval recorded").first()).toBeVisible();
  expect(approved.calls.some((call) => call.path === "/proposals/proposal-1/approve")).toBeTruthy();

  const declined = stateWithProfile();
  await installApi(page, declined);
  await page.reload();
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Trade proposal declined").first()).toBeVisible();
  expect(declined.calls.some((call) => call.path === "/proposals/proposal-1/reject")).toBeTruthy();
});

test("requires confirmation before halting every portfolio", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "The control is covered in the desktop workspace flow.");
  const state = stateWithProfile();
  await installApi(page, state);
  await page.goto("/");
  await page.getByRole("button", { name: "Halt everything" }).click();
  await expect(page.getByText("Halt everything?")).toBeVisible();
  await page.getByRole("button", { name: "Halt", exact: true }).click();
  await expect.poll(() => state.halted).toBe(true);
  await page.getByRole("button", { name: "Resume everything" }).click();
  await expect.poll(() => state.halted).toBe(false);
  expect(state.calls.some((call) => call.path === "/system/resume")).toBeTruthy();
});

test("keeps essential controls reachable on mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "Requires the configured Pixel 5 viewport.");
  await installApi(page, stateWithProfile());
  await page.goto("/");
  await expect(page.getByText("Dino Agent")).toBeVisible();
  await expect(page.getByRole("button", { name: "Graph", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Halt everything" })).toBeVisible();
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close inspector" }).last()).toBeVisible();
});
