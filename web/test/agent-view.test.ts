import { describe, expect, it } from "vitest";
import { reconcileSettlements } from "../src/lib/agent-view";
import type { AgentEvent } from "../src/lib/agent-types";

describe("reconcileSettlements", () => {
  it("marks a submitted exchange as confirmed once verify arrives", () => {
    const events: AgentEvent[] = [
      {
        id: "1",
        step: "execute",
        at: 1,
        title: "Exchange order sent",
        kind: "trade.submitted",
        settlement: { txHash: "pending", status: "submitted", feeUsd: 0, submittedAt: 1 },
      },
      {
        id: "2",
        step: "verify",
        at: 2,
        title: "Swap completed",
        kind: "trade.verified",
        settlement: { txHash: "0.0.1@1.2", status: "confirmed", feeUsd: 0, submittedAt: 1, confirmedAt: 2 },
      },
    ];
    const next = reconcileSettlements(events);
    expect(next[0]?.settlement?.status).toBe("confirmed");
    expect(next[0]?.settlement?.txHash).toBe("0.0.1@1.2");
    expect(next[0]?.settlement?.confirmedAt).toBe(2);
  });
});
