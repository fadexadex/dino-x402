import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { MockDataProvider } from "../src/providers/mock/mock-provider.js";
import type { ServerConfig } from "../src/core/config.js";
import { store } from "../src/store/index.js";

const config: ServerConfig = {
  hederaNetwork: "hedera:testnet",
  facilitatorUrl: "https://api.testnet.blocky402.com",
  payToAccount: "0.0.1234",
  dataProvider: "mock",
  port: 4021,
};

const app = createApp(new MockDataProvider(), config, { initializePayments: false });

describe("resource server pre-validation (offline)", () => {
  it("404 for an unknown product", async () => {
    const res = await app.request("/data/does-not-exist?symbol=AAPL");
    expect(res.status).toBe(404);
  });

  it("400 when a required param is missing", async () => {
    const res = await app.request("/data/ohlc?symbol=AAPL");
    expect(res.status).toBe(400);
  });

  it("serves the catalog without payment", async () => {
    const res = await app.request("/catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: unknown[] };
    expect(body.products.length).toBe(3);
  });

  it("reports readiness as booleans without exposing credential material", async () => {
    const secretConfig: ServerConfig = {
      ...config,
      agentPayerId: "0.0.5678",
      agentPayerKey: "test-only-private-key",
      mistralApiKey: "test-only-mistral-key",
    };
    const secretApp = createApp(new MockDataProvider(), secretConfig, { initializePayments: false });
    const res = await secretApp.request("/api/health");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).agent).toEqual({ paymentReady: true, mistralReady: true });
    expect(text).not.toContain(secretConfig.agentPayerKey);
    expect(text).not.toContain(secretConfig.mistralApiKey);
  });

  it("rejects malformed agent JSON before running", async () => {
    const res = await app.request("/api/agent/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
  });
});

describe("wallet account connect (offline)", () => {
  it("creates a user_wallet profile from a Hedera account id", async () => {
    const accountId = `0.0.${Math.floor(Math.random() * 1_000_000_000)}`;
    const res = await app.request("/api/account/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId, label: "Playwright wallet" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { accountId: string; profileId: string };
    expect(body.accountId).toBe(accountId);
    const profile = store.getProfile(body.profileId);
    expect(profile).toMatchObject({ kind: "user_wallet", accountId, autonomyMode: 1, status: "paused" });
    expect(store.getLatestMandate(body.profileId)?.profileId).toBe(body.profileId);
  });

  it("completes approval-gated onboarding without enabling autonomous trading", async () => {
    const accountId = `0.0.${Math.floor(Math.random() * 1_000_000_000)}`;
    await app.request("/api/account/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    const res = await app.request("/api/v1/onboarding/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autonomyMode: 3, objective: "stay in the loop" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { autonomyMode: number; custody: string; approvalRequired: boolean };
    expect(body).toMatchObject({ autonomyMode: 3, custody: "user_wallet", approvalRequired: true });
    expect(store.getState().schedule.autonomousTrading).toBe(false);
  });
});

describe("Dino profile read models (offline)", () => {
  const profileId = `ui-${randomUUID()}`;
  store.upsertProfile({ id: profileId, name: "UI test wallet", kind: "user_wallet", accountId: "0.0.77777", network: "hedera:testnet", status: "active", autonomyMode: 3, cadenceMinutes: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

  it("returns evidence-only dashboard, graph, and receipts with safe empty series", async () => {
    const dashboard = await app.request(`/api/v1/profiles/${profileId}/dashboard`);
    expect(dashboard.status).toBe(200);
    const body = await dashboard.json() as { profile: { id: string }; portfolio: unknown; events: unknown[]; spend: { dataHbar: number } };
    expect(body.profile.id).toBe(profileId);
    // Live Mirror read may fail offline for synthetic accounts; either null or a shaped object is fine.
    expect(body.portfolio === null || typeof body.portfolio === "object").toBe(true);
    expect(body.events.every((event) => typeof event === "object")).toBe(true);
    expect(body.events.every((event) => {
      const kind = (event as { kind?: string }).kind ?? "";
      return !kind.startsWith("profile.");
    })).toBe(true);
    expect(body.spend.dataHbar).toBeTypeOf("number");
    const graph = await app.request(`/api/v1/profiles/${profileId}/graph?series=HBAR`);
    expect(await graph.json()).toMatchObject({ series: "HBAR", ticks: [], markers: [] });
    const receipts = await app.request(`/api/v1/profiles/${profileId}/receipts`);
    expect(await receipts.json()).toEqual({ receipts: [] });
  });

  it("versions a validated mandate and enforces 1-4 custody-aware autonomy modes", async () => {
    const mandate = await app.request(`/api/v1/profiles/${profileId}/mandate`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "stay in bands", allocations: [
        { symbol: "HBAR", minPct: 20, targetPct: 40, maxPct: 60 },
        { symbol: "USDC", minPct: 20, targetPct: 40, maxPct: 60 },
        { symbol: "SAUCE", minPct: 0, targetPct: 20, maxPct: 40 },
      ], risk: { maxTradesPerDay: 2 } }),
    });
    expect(mandate.status).toBe(200);
    expect((await mandate.json() as { version: number; limits: { maxTradesPerDay: number } }).limits.maxTradesPerDay).toBe(2);
    const mode2 = await app.request(`/api/v1/profiles/${profileId}/schedule`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ cadenceMinutes: 5, paused: false, autonomyMode: 2 }) });
    expect(await mode2.json()).toMatchObject({ autonomyMode: 2, autonomousTrading: false });
    const mode4 = await app.request(`/api/v1/profiles/${profileId}/schedule`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ autonomyMode: 4 }) });
    expect(mode4.status).toBe(403);
    await app.request(`/api/v1/profiles/${profileId}/schedule`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: true }) });
  });

  it("closes an approval-waiting run when its final proposal is rejected", async () => {
    const runId = randomUUID();
    const tradeId = randomUUID();
    store.addRun({ id: runId, accountId: "0.0.77777", profileId, startedAt: new Date().toISOString(), status: "waiting_approval", objective: "test rejection", dataPurchases: [], spentDataHbar: 0, tradeProposals: [], tradeExecutions: [], pendingTradeIds: [tradeId], events: [] }, profileId);
    store.addPendingTrade({ id: tradeId, runId, accountId: "0.0.77777", createdAt: new Date().toISOString(), status: "pending", proposal: { action: "swap", fromSymbol: "HBAR", toSymbol: "USDC", percentage: 1, amountFormatted: 1, reasoning: "test", confidence: 1, source: "deterministic" } }, profileId);

    const rejected = await app.request(`/api/v1/proposals/${tradeId}/reject`, { method: "POST" });
    expect(rejected.status).toBe(200);
    expect(store.getState().runs.find((run) => run.id === runId)?.status).toBe("completed");
    const dashboard = await app.request(`/api/v1/profiles/${profileId}/dashboard`);
    const body = await dashboard.json() as { runs: Array<{ id: string; status: string }> };
    expect(body.runs.find((run) => run.id === runId)?.status).toBe("completed");
  });
});
