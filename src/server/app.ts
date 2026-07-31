import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import type { DataProvider } from "../core/provider.js";
import type { ServerConfig } from "../core/config.js";
import { buildFacilitator } from "../core/facilitator.js";
import { validateRequest, productIdFromPath, priceForProduct } from "../core/catalog.js";
import { AgentRunner } from "../agent/runner.js";
import type { AgentRunInput } from "../agent/types.js";

export interface CreateAppOptions {
  initializePayments?: boolean;
}

export const createApp = (
  provider: DataProvider,
  config: ServerConfig,
  options: CreateAppOptions = {},
): Hono => {
  const catalog = provider.catalog();
  const app = new Hono();
  const agent = new AgentRunner(config);
  const initializePayments = options.initializePayments ?? true;

  const routes: RoutesConfig = {
    "GET /data/:product": {
      description: "Financial market data — price and params vary by product",
      accepts: {
        scheme: "exact",
        network: config.hederaNetwork as Network,
        payTo: config.payToAccount,
        price: (ctx) => priceForProduct(catalog, productIdFromPath(ctx.path)),
        maxTimeoutSeconds: 180,
      },
    },
  };

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.use("/api/*", cors({
    origin: (origin) => {
      if (!origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
      return "";
    },
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }));

  app.get("/api/health", (c) => c.json({
    status: "ok",
    network: config.hederaNetwork,
    providerId: provider.id,
    agent: {
      paymentReady: agent.isPaymentReady(),
      mistralReady: Boolean(config.mistralApiKey),
    },
  }));

  app.post("/api/agent/run", async (c) => {
    let input: AgentRunInput = {};
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        input = await c.req.json<AgentRunInput>();
      } catch {
        return c.json({ error: "Request body must be valid JSON" }, 400);
      }
    }
    const result = await agent.run(input);
    return c.json(result, result.status === "completed" ? 200 : 502);
  });

  app.get("/catalog", (c) => c.json({ providerId: provider.id, products: catalog }));

  app.use("/data/:product", async (c, next) => {
    const productId = c.req.param("product");
    const error = validateRequest(catalog, productId, c.req.query());
    if (error) return c.json({ error: error.message }, error.status);
    await next();
  });

  if (initializePayments) {
    const x402Server = new x402ResourceServer(buildFacilitator(config.facilitatorUrl)).register(
      "hedera:*",
      new ExactHederaScheme(),
    );
    app.use("*", paymentMiddleware(routes, x402Server));
  }

  app.get("/data/:product", async (c) => {
    const productId = c.req.param("product");
    const params = c.req.query();
    const result = await provider.fetch(productId, params);
    return c.json({
      product: productId,
      params,
      data: result.data,
      asOf: result.asOf,
      providerId: result.providerId,
    });
  });

  return app;
};
