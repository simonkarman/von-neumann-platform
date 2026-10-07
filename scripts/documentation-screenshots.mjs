// Real UI captures with isolated synthetic data. Never connects to a deployed account.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

const port = Number(process.env.DOCS_PORT || 4328);
const base = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString("base64url");
const env = { ...process.env };
for (const name of Object.keys(env))
  if (
    /^(AWS_|GOOGLE_|VERTEX_|BEDROCK_|OPENAI_|COPILOT_)|SECRET_ARN$/.test(name)
  )
    delete env[name];
Object.assign(env, {
  DOTENV_CONFIG_PATH: "/dev/null",
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: String(port),
  PUBLIC_URL: base,
  AI_PROVIDER: "demo",
  AWS_MODE: "demo",
  AWS_REGION: "eu-west-1",
  DATA_DIR: `.data/documentation-${randomBytes(8).toString("hex")}`,
  ADMIN_PASSWORD: password,
  SESSION_SECRET: randomBytes(32).toString("hex"),
  RUNTIME_DRIVER: "process",
  DASHBOARD_TEMPLATE_DIR: "dashboard-base",
  DASHBOARD_REPO_URL: "",
  MAX_ACTIVE_SESSIONS: "4",
  MAX_DAILY_PROMPTS: "100",
});
// Do not adopt an unrelated listener already on this port.
const { createServer } = await import("node:net");
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(port, "127.0.0.1", resolve);
});
await new Promise((resolve) => probe.close(resolve));
await mkdir("blog/images", { recursive: true });
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let diagnostics = "";
for (const stream of [server.stdout, server.stderr])
  stream.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-6000);
  });
let browser;
try {
  const deadline = Date.now() + 45000;
  for (;;) {
    if (server.exitCode !== null)
      throw new Error(`Demo server exited: ${diagnostics}`);
    if (
      await fetch(`${base}/healthz`)
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    if (Date.now() > deadline)
      throw new Error(`Demo startup timed out: ${diagnostics}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1680, height: 1080 },
    deviceScaleFactor: 1,
    locale: "en-GB",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel("Workspace password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Your living workspace" }),
  ).toBeVisible();
  async function capture(name) {
    await page.setViewportSize({ width: 1680, height: name === "cloud-operations" ? 1200 : 1080 });
    await expect(page.locator("body")).toContainText(/demo/i, {
      timeout: 15000,
    });
    await page.evaluate(() => document.fonts.ready);
    await page
      .locator(".dashboard-content")
      .evaluateAll((elements) => elements.forEach((el) => (el.scrollTop = 0)));
    await expect(page.locator(".error-banner")).toHaveCount(0);
    const text = await page.locator("body").innerText();
    assert.doesNotMatch(
      text,
      /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|arn:aws:|\b\d{12}\b|BEGIN.*PRIVATE KEY/,
    );
    assert.ok(
      text.includes("Demo") || text.includes("demo"),
      "Screenshots must visibly identify synthetic data",
    );
    await page.screenshot({
      path: `blog/images/${name}.png`,
      animations: "disabled",
    });
    console.log(`Captured ${name} (demo data only)`);
  }
  async function send(prompt) {
    const input = page.getByRole("textbox", { name: "Ask your data" });
    await expect(input).toBeEnabled({ timeout: 120000 });
    await input.fill(prompt);
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/prompt") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Send prompt" }).click();
    const r = await response;
    assert.ok(r.ok());
    await r.finished();
    assert.ok(
      !(await r.text())
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)))
        .some((e) => e.type === "error"),
      "Prompt must succeed before capture",
    );
    await expect(input).toBeEnabled({ timeout: 90000 });
  }
  await page.locator("#create").click();
  await expect(
    page.getByRole("heading", { name: "What would you like to see?" }),
  ).toBeVisible({ timeout: 120000 });
  await capture("empty-dashboard");
  await send("Rename this dashboard to Cloud operations");
  await send(
    "Add a CPU graph highlighting values over 70% and a log download button.",
  );
  await send("Add a users table showing signups.");
  await expect(
    page.getByRole("img", { name: /CPU utilization over time/ }),
  ).toBeVisible();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await page.getByLabel("Time window").selectOption("4");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download logs" }).click();
  assert.match((await download).suggestedFilename(), /^logs-.*\.jsonl$/);
  await capture("cloud-operations");

  await page.goto(base);
  await page.locator("#create").click();
  await send("Rename this dashboard to Interactive capacity explorer");
  await send("Build a 3D capacity explorer with arrow key flight.");
  const canvas = page.locator(".custom-scene canvas");
  await expect(canvas).toBeVisible();
  await page.getByRole("button", { name: "Increment", exact: true }).click();
  await expect(page.locator(".custom-cards strong")).toHaveText("1");
  const before = await canvas.screenshot();
  await canvas.focus();
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(250);
  await page.keyboard.up("ArrowUp");
  assert.ok(
    !before.equals(await canvas.screenshot()),
    "Keyboard flight must change the rendered scene",
  );
  await capture("interactive-capacity");
  await page.goto(base);
  await expect(page.locator("article.session-card")).toHaveCount(2);
  await expect(
    page
      .getByRole("navigation", { name: "Recent dashboards" })
      .getByRole("link"),
  ).toHaveCount(2);
  await capture("workspace");
  await page
    .getByRole("button", { name: "About Amazon Web Services source" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Amazon Web Services" }),
  ).toBeVisible();
  await capture("source-details");
  await page.getByRole("button", { name: "Close source details" }).click();
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log(
    "Documentation captures verified: real prompts, HMR, log download and custom interaction.",
  );
} finally {
  await browser?.close();
  const stopped = once(server, "exit");
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 15000);
    await stopped;
    clearTimeout(timer);
  }
  console.log(
    "Documentation demo server stopped; no live cloud credentials were used.",
  );
}
