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
  "Run another autonomous check-in. Show me your thoughts while you buy HBAR/USDC/SAUCE intelligence and judge the bands.";

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
  await page.request.post(`${BASE}/api/v1/onboarding/complete`, {
    data: {
      autonomyMode: 4,
      objective: "Keep HBAR, USDC, and SAUCE within their configured allocation bands.",
    },
  });

  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(2000);
  await shot("01-workspace-loaded");

  // Show prior graph data if present.
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

  await page.getByText(/Thinking|Buying|Reading live portfolio/i).first().waitFor({ timeout: 60_000 });
  await shot("05-thinking-started");

  const deadline = Date.now() + 300_000;
  let phase = "start";
  while (Date.now() < deadline) {
    const text = await bodyText();
    if (phase === "start" && /Buying .* intelligence|paid signal|x402/i.test(text)) {
      phase = "buying";
      await shot("06-buying-intelligence");
    }
    if ((phase === "buying" || phase === "start") && /payment verified|HBAR payment verified/i.test(text)) {
      phase = "settled";
      await shot("07-payment-settled");
    }
    if (/Deterministic portfolio evaluation|Trade proposed|Trade verified|bands look healthy|Trade blocked|Trade skipped/i.test(text)) {
      phase = "analyzed";
      await shot("08-analysis");
    }
    // True completion: thought summary OR verified/no-action outcome and not "Thinking…"
    const done =
      (/Thought for \d+s/i.test(text) || /Trade verified on Hedera|bands look healthy|Observe-only check-in complete|Run stopped safely/i.test(text)) &&
      !/Buying (HBAR|USDC|SAUCE) intelligence/i.test(text) &&
      !/\brunning\b/i.test(await page.locator("text=/running/i").first().innerText().catch(() => ""));
    // Prefer API truth.
    const api = await page.request.get(`${BASE}/api/v1/profiles/agent-managed/dashboard`);
    const dash = await api.json();
    const status = dash?.runs?.[0]?.status;
    if (status && status !== "running") {
      console.log("run status", status);
      break;
    }
    if (done && phase === "analyzed") break;
    await page.waitForTimeout(2500);
  }

  await page.waitForTimeout(2000);
  await shot("09-run-complete");

  if (await graphBtn.isVisible().catch(() => false)) {
    const graphVisible = await page.getByText(/HBAR \/ USDC|paid feed/i).first().isVisible().catch(() => false);
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

  // Scroll activity stream to show user bubble + steps.
  await page.evaluate(() => {
    const main = document.querySelector("main .overflow-auto");
    if (main) main.scrollTop = 0;
  });
  await page.waitForTimeout(800);
  await shot("12-stream-top");

  console.log("demo finished ok");
} catch (error) {
  await shot("error-state");
  console.error(error);
  process.exitCode = 1;
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  if (video) {
    const path = await video.path();
    const dest = `${OUT}/dino-autonomous-demo.webm`;
    if (existsSync(path)) {
      try { renameSync(path, dest); } catch { copyFileSync(path, dest); }
      console.log(`video ${dest}`);
    }
  }
}
