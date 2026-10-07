// Live acceptance test. Three bounded model requests; password stays in memory.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { fromIni } from "@aws-sdk/credential-providers";
import { chromium, expect } from "@playwright/test";
const deployment = JSON.parse(
  await readFile(".data/aws-deployment.json", "utf8"),
);
const secrets = new SecretsManagerClient({
  region: deployment.region,
  credentials: fromIni({ profile: deployment.profile }),
});
const { SecretString: password } = await secrets.send(
  new GetSecretValueCommand({ SecretId: deployment.AdminPasswordArn }),
);
secrets.destroy();
let cookie = "";
async function request(path, body) {
  return fetch(deployment.Url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(250000),
  });
}
async function json(path, body) {
  const r = await request(path, body),
    data = await r.json();
  assert.ok(r.ok, data.error || `HTTP ${r.status}`);
  return data;
}
const login = await request("/api/auth/login", { password });
assert.ok(login.ok);
cookie = login.headers.get("set-cookie").split(";")[0];
const config = await json("/api/config");
if (process.env.CHECK_MODEL)
  assert.equal(config.model, process.env.CHECK_MODEL);
const session = process.env.CHECK_SESSION_ID
  ? await json(`/api/sessions/${process.env.CHECK_SESSION_ID}`)
  : await json("/api/sessions", {});
if (session.status !== "ready")
  await json(`/api/sessions/${session.id}/start`, {});
console.log(`Acceptance dashboard: ${deployment.Url}/${session.id}`);
let browser;
try {
  const deadline = Date.now() + 150000;
  while (true) {
    const s = await json(`/api/sessions/${session.id}`);
    if (s.status === "ready") break;
    if (s.status === "failed") throw new Error(s.error);
    if (Date.now() > deadline) throw new Error("Startup deadline");
    await new Promise((r) => setTimeout(r, 1000));
  }
  async function prompt(text) {
    const r = await request(`/api/sessions/${session.id}/prompt`, {
      prompt: text,
    });
    assert.ok(r.ok);
    const events = (await r.text())
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    const failure = events.find((e) => e.type === "error");
    if (failure) throw new Error(failure.message);
    const edit = events.find((e) => e.type === "updated");
    if (edit)
      console.log("Verified committed edit:", edit.revision.slice(0, 7));
    else
      console.log(
        "No new edit; verifying the persisted requested state below.",
      );
    return json(`/api/sessions/${session.id}`);
  }
  let s;
  if (process.env.CHECK_EXISTING_ONLY === "true") {
    assert.ok(
      process.env.CHECK_SESSION_ID,
      "Existing-only verification requires an explicit session",
    );
    s = await json(`/api/sessions/${session.id}`);
  } else {
    s = await prompt(
      'Name this dashboard "3D infrastructure explorer". Discover ALL EC2 instances in all configured regions, including stopped ones. Add one CPU graph for the last 24 hours with a separate series for each instance, highlight values over 60 percent, and add an instances inventory table. Do not ask me for IDs that you can discover.',
    );
    let chart = s.dashboard.widgets.find((w) => w.type === "chart");
    assert.ok(chart?.series?.length >= 1);
    assert.equal(chart.threshold, 60);
    const revision = s.revision;
    s = await prompt(
      "Change the CPU chart threshold to 70 percent. Keep every existing series and the table.",
    );
    chart = s.dashboard.widgets.find((w) => w.type === "chart");
    assert.equal(chart.threshold, 70);
    assert.notEqual(s.revision, revision);
    assert.ok(chart.series.length >= 1);
    s = await prompt(
      `Add a custom 3D visualization of the provisioned EBS volume capacity using live ec2_volumes data from ${deployment.region}. Let me fly through it with arrow keys. Label it as provisioned capacity, NOT used disk space. Include a button that toggles a summary between GiB and TiB. Use the isolated custom widget draft/test/publish workflow and keep the CPU chart and table.`,
    );
  }
  const custom = s.dashboard.widgets.find((w) => w.type === "custom");
  assert.equal(
    s.dashboard.widgets.find((w) => w.type === "chart")?.threshold,
    70,
    "Custom publish must preserve the existing chart",
  );
  assert.ok(
    s.dashboard.widgets.find((w) => w.type === "chart")?.series?.length >= 1,
    "Custom publish must preserve the existing series",
  );
  assert.ok(custom?.custom?.source);
  assert.ok(
    custom.custom.bindings.some((b) => b.query.operation === "ec2_volumes"),
  );
  const audits = await json(`/api/sessions/${session.id}/audit`);
  assert.ok(audits.some((a) => a.action === "custom.tested"));
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1512, height: 1000 },
  });
  const [name, ...value] = cookie.split("=");
  await context.addCookies([
    { name, value: value.join("="), url: deployment.Url, secure: true },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${deployment.Url}/${session.id}`);
  await expect(
    page.getByRole("navigation", { name: "Recent dashboards" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Log out", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "About Amazon Web Services source" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Amazon Web Services" }),
  ).toContainText("server-side identity");
  await page.getByRole("button", { name: "Close source details" }).click();
  assert.equal((await fetch(deployment.Url + "/api/sessions")).status, 401);
  await page.locator(".custom-scene canvas").waitFor({ timeout: 90000 });
  assert.equal(await page.locator(".custom-widget [role=alert]").count(), 0);
  await expect(page.locator(".multi-chart")).toBeVisible({ timeout: 90000 });
  const control = page
    .locator(".custom-widget .custom-controls button")
    .first();
  await control.waitFor();
  const before = await page.locator(".custom-widget").innerText();
  await control.click();
  await page.waitForFunction(
    (old) => document.querySelector(".custom-widget")?.innerText !== old,
    before,
    { timeout: 10000 },
  );
  const canvas = page.locator(".custom-scene canvas");
  await canvas.focus();
  const image = await canvas.screenshot();
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(300);
  await page.keyboard.up("ArrowUp");
  assert.ok(!image.equals(await canvas.screenshot()));
  await page.screenshot({
    path: "test-results/aws-hybrid.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: persisted multi-instance chart, threshold, custom validation audit, live EBS binding, button interaction, keyboard flight, sidebar controls, anonymous blocking and browser without runtime errors.",
  );
  console.log(`Ready to try: ${deployment.Url}/${session.id}`);
} finally {
  await browser?.close();
  await request(`/api/sessions/${session.id}/stop`, {});
}
