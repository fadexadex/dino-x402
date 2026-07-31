import type { DataProvider } from "../core/provider.js";
import { MockDataProvider } from "./mock/mock-provider.js";
import { MarketDataProvider } from "./market/market-provider.js";

export const createProvider = (id: string): DataProvider => {
  switch (id) {
    case "market":
      return new MarketDataProvider();
    case "mock":
      return new MockDataProvider();
    default:
      throw new Error(`Unknown DATA_PROVIDER: ${id}`);
  }
};
