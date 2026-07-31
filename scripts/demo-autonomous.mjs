/**
 * Records an autonomous-mode workspace demo: user message, live thoughts, graph.
 * Output: /opt/cursor/artifacts/dino-autonomous-demo.webm (+ screenshots)
 */
import { chromium } from "playwright";
import { mkdirSync, copyFileSync, renameSync, existsSync } from "node:fs";

const OUT = "/opt/cursor/artifacts";
mkdirSync(OUT, { recursive: true });
mkdirSync(`${OUT}/demo-frames`, { recursive: true });

const BASE = process.env.DEMO_URL ?? "http://localhost:4321";
const OBJECTIVE =
  "Run another autonomous check-in. Show me your thoughts while you buy HBAR/USDC/SAUCE market data and judge the mix.";

const browser = await chromium.launch({
  headless: true,
  args: ["--window-size=1440,900"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: `${OUT}/demo-frames`, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`screenshot ${name}`);
};

const bodyText = async () => page.locator("body").innerText();

try {
  // Also capture onboarding fork for the recording.
  await page.goto(`${BASE}/connect`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(1200);
  await shot("00-onboarding-custody");

  await page.request.post(`${BASE}/api/v1/onboarding/complete`, {
    data: {
      autonomyMode: 4,
      objective: "Keep HBAR, USDC, and SAUCE within their configured allocation bands.",
    },
  });

  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(2000);
  await shot("01-workspace-loaded");

  // Mobile-ish responsive check.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await shot("01b-mobile-workspace");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(600);

  const graphBtn = page.getByRole("button", { name: /^Graph$/i });
  if (await graphBtn.isVisible().catch(() => false)) {
    await graphBtn.click();
    await page.waitForTimeout(1200);
    await shot("02-graph-prior");
  }

  const composer = page.locator("textarea").first();
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.click();
  await composer.fill(OBJECTIVE);
  await shot("03-message-typed");
  await page.getByRole("button", { name: /^Send$/i }).click();

  await page.getByText(OBJECTIVE.slice(0, 32), { exact: false }).first().waitFor({ timeout: 15_000 });
  await shot("04-user-message-visible");

  await page.getByText(/Thinking|Paying for|Checking your live balances|Buy market data/i).first().waitFor({ timeout: 60_000 });
  await shot("05-thinking-started");

  const deadline = Date.now() + 300_000;
  let phase = "start";
  while (Date.now() < deadline) {
    const text = await bodyText();
    if (phase === "start" && /Paying for .* market data|Buying .* intelligence|market data unlocked|x402/i.test(text)) {
      phase = "buying";
      await shot("06-buying-intelligence");
    }
    if ((phase === "buying" || phase === "start") && /market data unlocked|payment verified|Payment confirmed/i.test(text)) {
      phase = "settled";
      await shot("07-payment-settled");
    }
    if (/Comparing your mix|Ready to rebalance|Swap completed|bands look healthy|Rebalance held|Trade blocked|no rebalance/i.test(text)) {
      phase = "analyzed";
      await shot("08-analysis");
    }
    const api = await page.request.get(`${BASE}/api/v1/profiles/agent-managed/dashboard`);
    const dash = await api.json();
    const status = dash?.runs?.[0]?.status;
    if (status && status !== "running") {
      console.log("run status", status, "portfolioAfter", Boolean(dash?.runs?.[0]?.portfolioAfter));
      break;
    }
    await page.waitForTimeout(2500);
  }

  await page.waitForTimeout(2000);
  await shot("09-run-complete");

  if (await graphBtn.isVisible().catch(() => false)) {
    const graphVisible = await page.getByText(/HBAR \/ USDC|paid feed|Portfolio/i).first().isVisible().catch(() => false);
    if (!graphVisible) await graphBtn.click().catch(() => undefined);
    await page.waitForTimeout(1500);
  }
  await shot("10-final-graph");

  const thoughtToggle = page.getByRole("button", { name: /Toggle thought|Thought for/i }).first();
  if (await thoughtToggle.isVisible().catch(() => false)) {
    await thoughtToggle.click().catch(() => undefined);
    await page.waitForTimeout(1000);
    await shot("11-thoughts-expanded");
  }

  await page.evaluate(() => {
    const main = document.querySelector("main .overflow-auto");
    if (main) main.scrollTop = 0;
  });
  await page.waitForTimeout(800);
  await shot("12-stream-top");

  const dash = await page.request.get(`${BASE}/api/v1/profiles/agent-managed/dashboard`).then((r) => r.json());
  console.log(JSON.stringify({
    runStatus: dash?.runs?.[0]?.status,
    hasPortfolioAfter: Boolean(dash?.runs?.[0]?.portfolioAfter),
    assets: dash?.portfolio?.assets?.map((a) => ({ symbol: a.symbol, balance: a.balance, pct: a.allocationPct })),
    eventKinds: (dash?.events ?? []).slice(-12).map((e) => e.kind),
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
    const dest = `${OUT}/dino-autonomous-demo.webm`;
    if (existsSync(path)) {
      try { renameSync(path, dest); } catch { copyFileSync(path, dest); }
      console.log("video", dest);
    }
  }
}
