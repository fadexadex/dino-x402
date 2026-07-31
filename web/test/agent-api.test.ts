import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDashboard, request } from "../src/lib/agent-api";

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe("agent API client", () => {
  it("returns an empty workspace without inventing a profile", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(loadDashboard()).resolves.toEqual({ profiles: [] });
  });

  it("does not surface an HTML error document as a misleading agent message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("<html>not found</html>", { status: 404, headers: { "Content-Type": "text/html" } }));
    await expect(request("/profiles")).rejects.toThrow("Request failed (404)");
  });
});
