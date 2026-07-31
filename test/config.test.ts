import { describe, it, expect, afterEach, vi } from "vitest";
import { loadConfig } from "../src/core/config.js";

afterEach(() => vi.unstubAllEnvs());

const stubAll = () => {
  vi.stubEnv("HEDERA_NETWORK", "hedera:testnet");
  vi.stubEnv("FACILITATOR_URL", "https://api.testnet.blocky402.com");
  vi.stubEnv("PAY_TO_ACCOUNT", "0.0.1234");
  vi.stubEnv("DATA_PROVIDER", "mock");
  vi.stubEnv("PORT", "4021");
  vi.stubEnv("HEDERA_CLIENT_ID", "");
  vi.stubEnv("HEDERA_CLIENT_KEY", "");
  vi.stubEnv("AGENT_DATA_BASE_URL", "");
  vi.stubEnv("AGENT_MAX_SPEND_ATOMIC", "");
  vi.stubEnv("MISTRAL_API_KEY", "");
  vi.stubEnv("MISTRAL_MODEL", "");
};

describe("loadConfig", () => {
  it("throws when a required env var is missing", () => {
    vi.stubEnv("HEDERA_NETWORK", "");
    vi.stubEnv("FACILITATOR_URL", "");
    vi.stubEnv("PAY_TO_ACCOUNT", "");
    expect(() => loadConfig()).toThrow(/FACILITATOR_URL|HEDERA_NETWORK|PAY_TO_ACCOUNT/);
  });

  it("returns a typed config when all vars are present", () => {
    stubAll();
    expect(loadConfig()).toEqual({
      hederaNetwork: "hedera:testnet",
      facilitatorUrl: "https://api.testnet.blocky402.com",
      payToAccount: "0.0.1234",
      dataProvider: "mock",
      port: 4021,
    });
  });

  it("loads optional agent settings without exposing them by default", () => {
    stubAll();
    vi.stubEnv("HEDERA_CLIENT_ID", "0.0.5678");
    vi.stubEnv("HEDERA_CLIENT_KEY", "placeholder-private-key");
    vi.stubEnv("AGENT_DATA_BASE_URL", "http://localhost:4021");
    vi.stubEnv("AGENT_MAX_SPEND_ATOMIC", "5000000");
    vi.stubEnv("MISTRAL_API_KEY", "placeholder-api-key");
    vi.stubEnv("MISTRAL_MODEL", "mistral-small-latest");

    expect(loadConfig()).toMatchObject({
      agentPayerId: "0.0.5678",
      agentPayerKey: "placeholder-private-key",
      agentDataBaseUrl: "http://localhost:4021",
      agentMaxSpendAtomic: "5000000",
      mistralApiKey: "placeholder-api-key",
      mistralModel: "mistral-small-latest",
    });
  });
});
