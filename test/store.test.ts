import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppStore } from "../src/store/index.js";
import type { AgentMultiRunRecord } from "../src/store/types.js";

const dirs: string[] = [];
function createStore(now = () => new Date("2026-07-31T12:00:00.000Z")): { store: AppStore; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dino-store-"));
  dirs.push(directory);
  const file = path.join(directory, "agent.sqlite");
  return { store: new AppStore({ databasePath: file, now }), file };
}
afterEach(() => { for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function run(id: string, status: AgentMultiRunRecord["status"] = "completed"): AgentMultiRunRecord {
  return { id, accountId: "0.0.123", startedAt: "2026-07-31T11:00:00.000Z", status, objective: "bands", dataPurchases: [], spentDataHbar: 0, tradeProposals: [], tradeExecutions: [], pendingTradeIds: [], events: [] };
}

describe("AppStore SQLite durability", () => {
  it("persists legacy projection and bigint values through restart", () => {
    const { store, file } = createStore();
    store.setAccount({ accountId: "0.0.123", connectedAt: "2026-07-31T12:00:00.000Z" });
    const record = run("run-1");
    // Exercise a value shape used by real SwapResult records.
    record.tradeExecutions = [{ success: true, transactionId: "0.0.1@1.2", hashscanUrl: "https://hashscan", fromToken: "0.0.0", fromSymbol: "HBAR", toToken: "0.0.2", toSymbol: "USDC", amountIn: 123n, amountInFormatted: 0.00000123 }];
    store.addRun(record);
    store.recordSpend(0.1, 0);
    store.close();

    const restored = new AppStore({ databasePath: file });
    expect(restored.getState().account?.accountId).toBe("0.0.123");
    expect(restored.getState().runs[0]?.tradeExecutions[0]?.amountIn).toBe(123n);
    expect(restored.getState().spending.totalDataHbar).toBeCloseTo(0.1);
    restored.close();
  });

  it("replays append-only events after the supplied SSE id and filters profiles", () => {
    const { store } = createStore();
    const first = store.appendEvent("run.triggered", { ok: true }, { profileId: "agent" });
    store.appendEvent("run.completed", { ok: true }, { profileId: "user" });
    const events = store.replayEvents(first.id, "user");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "run.completed", profileId: "user" });
    expect(events[0]!.sequence).toBeGreaterThan(first.sequence);
    store.close();
  });

  it("scopes persisted multi-asset run and proposal lifecycle records to the profile", () => {
    const { store } = createStore();
    store.addRun(run("scoped"), "agent-profile");
    const events = store.replayEvents(undefined, "agent-profile");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "run.created", runId: "scoped", profileId: "agent-profile" });
    store.close();
  });

  it("uses expiry-aware scheduler leases so only one scheduler holder proceeds", () => {
    let instant = new Date("2026-07-31T12:00:00.000Z");
    const { store } = createStore(() => instant);
    expect(store.acquireLease("profile:agent", "one", 1_000)?.holderId).toBe("one");
    expect(store.acquireLease("profile:agent", "two", 1_000)).toBeNull();
    instant = new Date("2026-07-31T12:00:02.000Z");
    expect(store.acquireLease("profile:agent", "two", 1_000)?.holderId).toBe("two");
    store.close();
  });

  it("marks an interrupted run failed on restart rather than resubmitting it", () => {
    const { store, file } = createStore();
    store.addRun(run("interrupted", "running"));
    store.close();
    const restored = new AppStore({ databasePath: file });
    expect(restored.getState().runs[0]).toMatchObject({ status: "failed", error: expect.stringContaining("Interrupted") });
    expect(restored.replayEvents().some((event) => event.type === "store.recovered")).toBe(true);
    restored.close();
  });

  it("persists profile, versioned mandate, and the global kill switch", () => {
    const { store, file } = createStore();
    store.upsertProfile({ id: "agent", name: "Agent account", kind: "agent_managed", accountId: "0.0.9", network: "hedera:testnet", status: "active", createdAt: "2026-07-31T12:00:00.000Z", updatedAt: "2026-07-31T12:00:00.000Z" });
    store.saveMandate({ id: "m1", profileId: "agent", version: 1, objective: "stay balanced", allocations: [{ symbol: "HBAR", minPct: 30, targetPct: 50, maxPct: 70 }], risk: { maxTradesPerDay: 6 }, createdAt: "2026-07-31T12:00:00.000Z" });
    store.setSystemHalt(true, "operator stop");
    store.close();
    const restored = new AppStore({ databasePath: file });
    expect(restored.getProfile("agent")?.accountId).toBe("0.0.9");
    expect(restored.getState().mandates).toHaveLength(1);
    expect(restored.isHalted()).toBe(true);
    restored.close();
  });

  it("clears profile runs without deleting the custody session", () => {
    const { store } = createStore();
    store.upsertProfile({
      id: "agent",
      name: "Agent account",
      kind: "agent_managed",
      accountId: "0.0.9",
      network: "hedera:testnet",
      status: "active",
      createdAt: "2026-07-31T12:00:00.000Z",
      updatedAt: "2026-07-31T12:00:00.000Z",
    });
    store.addRun(run("keep-scope"), "agent");
    store.appendEvent("agent.thinking", { text: "hi" }, { profileId: "agent", runId: "keep-scope" });
    const cleared = store.clearProfileSession("agent");
    expect(cleared.clearedRuns).toBe(1);
    expect(store.getState().runs).toHaveLength(0);
    expect(store.getProfile("agent")?.status).toBe("active");
    store.close();
  });

  it("removes paused wallet sessions but keeps the agent treasury", () => {
    const { store } = createStore();
    store.upsertProfile({
      id: "agent-managed",
      name: "Agent",
      kind: "agent_managed",
      accountId: "0.0.9",
      network: "hedera:testnet",
      status: "paused",
      createdAt: "2026-07-31T12:00:00.000Z",
      updatedAt: "2026-07-31T12:00:00.000Z",
    });
    store.upsertProfile({
      id: "user-wallet-0.0.1",
      name: "Wallet",
      kind: "user_wallet",
      accountId: "0.0.1",
      network: "hedera:testnet",
      status: "paused",
      createdAt: "2026-07-31T12:00:00.000Z",
      updatedAt: "2026-07-31T12:00:00.000Z",
    });
    expect(() => store.removeProfile("agent-managed")).toThrow(/cannot be removed/i);
    expect(store.removeProfile("user-wallet-0.0.1")).toBe(true);
    expect(store.getProfile("user-wallet-0.0.1")).toBeNull();
    store.close();
  });
});
