import { describe, expect, it } from "vitest";
import { AgentRunner, hashscanTransactionUrl } from "../src/agent/runner.js";
import type { ServerConfig } from "../src/core/config.js";

const config: ServerConfig = {
  hederaNetwork: "hedera:testnet",
  facilitatorUrl: "https://api.testnet.blocky402.com",
  payToAccount: "0.0.2222",
  dataProvider: "mock",
  port: 4021,
  agentPayerId: "0.0.1111",
  agentPayerKey: "test-only-private-key-that-must-never-leak",
  agentMaxSpendAtomic: "5000000",
  mistralApiKey: "test-only-api-key-that-must-never-leak",
};

describe("agent safety and proof helpers", () => {
  it("formats a native Hedera transaction id as a HashScan testnet link", () => {
    expect(hashscanTransactionUrl("0.0.7162784@1720000000.123456789")).toBe(
      "https://hashscan.io/testnet/transaction/0.0.7162784-1720000000-123456789",
    );
  });

  it("fails an invalid budget before network access and redacts configured secrets", async () => {
    const result = await new AgentRunner(config).run({ budgetAtomic: "0" });
    expect(result.status).toBe("failed");
    expect(result.spentAtomic).toBe("0");
    expect(result.events.at(-1)?.kind).toBe("run.failed");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(config.agentPayerKey);
    expect(serialized).not.toContain(config.mistralApiKey);
  });
});
