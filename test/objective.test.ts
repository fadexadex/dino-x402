import { describe, expect, it } from "vitest";
import { classifyObjective, focusSymbolFromObjective, formatTradeAmount } from "../src/agent/objective.js";

describe("objective intent", () => {
  it("treats research / investigate prompts as non-trading", () => {
    expect(classifyObjective(
      "Can you research about source? Don't make any traits yet, just browse and investigate.",
      true,
    )).toBe("research");
    expect(focusSymbolFromObjective("research about source")).toBe("SAUCE");
  });

  it("treats market recommendation prompts as advise", () => {
    expect(classifyObjective("check the market and give me recommendations", true)).toBe("advise");
  });

  it("keeps scheduled default objectives in act mode", () => {
    expect(classifyObjective("Autonomous multi-asset portfolio monitoring and rebalancing", false)).toBe("act");
    expect(classifyObjective("rebalance USDC into SAUCE", true)).toBe("act");
  });

  it("formats trade amounts without float noise", () => {
    expect(formatTradeAmount(2.0115430499999998)).toBe("2.0115");
  });
});
