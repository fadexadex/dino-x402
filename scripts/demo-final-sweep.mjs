/**
 * Final sweep recording: onboarding custody fork → Mode 4 workspace →
 * live thoughts / CoinGecko pays → swap → portfolio refresh → graph.
 */
import { chromium } from "playwright";
import { mkdirSync, copyFileSync, renameSync, existsSync } from "node:fs";

const OUT = "/opt/cursor/artifacts";
mkdirSync(OUT, { recursive: true });
mkdirSync(`${OUT}/demo-frames`, { recursive: true });
const BASE = process.env.DEMO_URL ?? "http://localhost:4321";

const browser = await chromium.launch({ headless: true, args: ["--window-size=1440,900"] });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: `${OUT}/demo-frames`, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/final-${name}.png`, fullPage: false });
  console.log("shot", name);
};

try {
  await page.goto(`${BASE}/connect`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.getByText(/How should money move/i).waitFor({ timeout: 15_000 });
  await shot("01-custody-fork");

  await page.request.post(`${BASE}/api/v1/onboarding/complete`, {
    data: { autonomyMode: 4, objective: "Keep HBAR, USDC, and SAUCE within their configured allocation bands." },
  });
  // Keep a slightly tight HBAR ceiling so a rebalance is likely if still over.
  await page.request.patch(`${BASE}/api/v1/profiles/agent-managed/mandate`, {
    data: {
      objective: "Keep the mix balanced; rotate over-ceiling HBAR toward SAUCE.",
      allocations: [
        { symbol: "HBAR", minPct: 15, targetPct: 30, maxPct: 38 },
        { symbol: "USDC", minPct: 20, targetPct: 35, maxPct: 45 },
        { symbol: "SAUCE", minPct: 15, targetPct: 35, maxPct: 50 },
      ],
    },
  });

  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("02-workspace");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  await shot("03-mobile");
  await page.setViewportSize({ width: 1440, height: 900 });

  const graphBtn = page.getByRole("button", { name: /^Graph$/i });
  if (await graphBtn.isVisible()) await graphBtn.click();
  await page.waitForTimeout(800);

  const objective = "Buy fresh CoinGecko quotes for HBAR, USDC, and SAUCE. If HBAR is over its ceiling, rebalance toward SAUCE and refresh the portfolio.";
  const composer = page.locator("textarea").first();
  await composer.fill(objective);
  await shot("04-typed");
  await page.getByRole("button", { name: /^Send$/i }).click();
  await page.getByText(objective.slice(0, 28), { exact: false }).first().waitFor({ timeout: 20_000 });
  await shot("05-streaming");

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const dash = await page.request.get(`${BASE}/api/v1/profiles/agent-managed/dashboard`).then((r) => r.json());
    const run = dash?.runs?.[0];
    if (run?.status && run.status !== "running") {
      console.log("done", run.status, "after", Boolean(run.portfolioAfter), "trades", (run.tradeExecutions || []).length);
      break;
    }
    await page.waitForTimeout(2000);
  }

  await page.waitForTimeout(1500);
  await shot("06-complete");
  await page.evaluate(() => {
    const main = document.querySelector("main .overflow-auto");
    if (main) main.scrollTop = main.scrollHeight;
  });
  await page.waitForTimeout(800);
  await shot("07-conclusion");

  const toggle = page.getByRole("button", { name: /Thought for|Toggle thought/i }).first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click().catch(() => undefined);
    await page.waitForTimeout(700);
    await shot("08-thoughts");
  }
  await shot("09-graph");

  const dash = await page.request.get(`${BASE}/api/v1/profiles/agent-managed/dashboard`).then((r) => r.json());
  console.log(JSON.stringify({
    assets: dash?.portfolio?.assets?.filter((a) => ["HBAR", "USDC", "SAUCE"].includes(a.symbol)).map((a) => ({
      symbol: a.symbol, balance: a.balance, pct: a.allocationPct, usd: a.usdValue,
    })),
    lastKinds: (dash?.events || []).slice(-15).map((e) => e.kind),
    after: Boolean(dash?.runs?.[0]?.portfolioAfter),
  }, null, 2));
} catch (error) {
  console.error(error);
  await shot("error");
  throw error;
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  if (video) {
    const path = await video.path();
    const dest = `${OUT}/dino-final-sweep.webm`;
    if (existsSync(path)) {
      try { renameSync(path, dest); } catch { copyFileSync(path, dest); }
      console.log("video", dest);
    }
  }
}
