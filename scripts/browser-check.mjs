import "dotenv/config";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const base =
  process.env.CHECK_URL || process.env.PUBLIC_URL || "http://127.0.0.1:4317";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  const login = await page.request.post(`${base}/api/auth/login`, {
    data: { password: process.env.ADMIN_PASSWORD || "" },
  });
  assert.ok(login.ok());
  const sessions = await (
    await page.request.get(`${base}/api/sessions`)
  ).json();
  const session = sessions.find((s) =>
    s.dashboard.widgets.some((w) => w.type === "chart"),
  );
  assert.ok(session, "A generated dashboard exists");
  await page.goto(`${base}/${session.id}`);
  await page.getByRole("textbox", { name: "Ask your data" }).waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector('textarea[aria-label="Ask your data"]')?.disabled,
  );
  await page.getByRole("img", { name: /CPU utilization over time/ }).waitFor();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/docker-vertex-dashboard.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("dialog", { name: "Dashboard history" }).waitFor();
  await page.getByRole("button", { name: "Close history" }).click();
  const share = await (
    await page.request.post(`${base}/api/sessions/${session.id}/share`, {
      data: {},
    })
  ).json();
  const guest = await browser.newContext(),
    viewer = await guest.newPage();
  await viewer.goto(share.url);
  await viewer
    .getByRole("img", { name: /CPU utilization over time/ })
    .waitFor();
  assert.equal(
    await viewer.getByRole("textbox", { name: "Ask your data" }).isDisabled(),
    true,
  );
  await guest.close();
  assert.deepEqual(errors, []);
  console.log(
    `Docker browser verified: ${base}/${session.id}; chart, hydration, history, and viewer sharing all work.`,
  );
} finally {
  await browser.close();
}
