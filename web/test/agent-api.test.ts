import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDashboard, request, setPreferredProfileId } from "../src/lib/agent-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  setPreferredProfileId(null);
});

describe("agent API client", () => {
  it("returns an empty workspace without inventing a profile", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ profiles: [], activeProfileId: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(loadDashboard()).resolves.toEqual({ profiles: [], activeProfileId: null });
  });

  it("does not surface an HTML error document as a misleading agent message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("<html>not found</html>", { status: 404, headers: { "Content-Type": "text/html" } }));
    await expect(request("/profiles")).rejects.toThrow("Request failed (404)");
  });

  it("prefers the active profile when multiple wallet sessions exist", async () => {
    const profiles = [
      { id: "user-wallet-0.0.1", name: "Wallet 1", kind: "user_wallet", accountId: "0.0.1", status: "paused", network: "hedera:testnet" },
      { id: "user-wallet-0.0.2", name: "Wallet 2", kind: "user_wallet", accountId: "0.0.2", status: "active", network: "hedera:testnet" },
      { id: "connected-wallet", name: "Connected wallet", kind: "user_wallet", accountId: "0.0.2", status: "active", network: "hedera:testnet" },
    ];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/profiles")) {
        return new Response(JSON.stringify({ profiles, activeProfileId: "user-wallet-0.0.2" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/dashboard")) {
        return new Response(JSON.stringify({ profile: profiles[1], events: [], runs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/graph")) return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("/receipts")) return new Response(JSON.stringify({ receipts: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const dashboard = await loadDashboard();
    expect(dashboard.profile?.id).toBe("user-wallet-0.0.2");
    expect(dashboard.activeProfileId).toBe("user-wallet-0.0.2");
    expect(dashboard.profiles?.some((profile) => profile.id === "user-wallet-0.0.1")).toBe(true);
  });

  it("ignores a stale paused local preference when another session is active", async () => {
    setPreferredProfileId("user-wallet-0.0.1");
    const profiles = [
      { id: "user-wallet-0.0.1", name: "Wallet 1", kind: "user_wallet", accountId: "0.0.1", status: "paused", network: "hedera:testnet" },
      { id: "agent-managed", name: "Autonomous agent", kind: "agent_managed", accountId: "0.0.9", status: "active", network: "hedera:testnet", autonomyMode: 4 },
    ];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/profiles")) {
        return new Response(JSON.stringify({ profiles, activeProfileId: "agent-managed" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/dashboard")) {
        return new Response(JSON.stringify({ profile: profiles[1], events: [], runs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/graph")) return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("/receipts")) return new Response(JSON.stringify({ receipts: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const dashboard = await loadDashboard();
    expect(dashboard.profile?.id).toBe("agent-managed");
    expect(dashboard.activeProfileId).toBe("agent-managed");
  });
});
