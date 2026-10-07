import { test, expect } from "@playwright/test";

test("sidebar recent navigation, source explanations, mobile access and logout", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Workspace password", { exact: true })
    .fill("test-only-workspace-password");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.locator(".workspace-label, .user-card")).toHaveCount(0);
  const source = page.getByRole("button", {
    name: "About Amazon Web Services source",
  });
  await source.click();
  await expect(
    page.getByRole("dialog", { name: "Amazon Web Services" }),
  ).toContainText("synthetic sample data");
  await page.keyboard.press("Escape");
  await expect(source).toBeFocused();
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Add a source" }),
  ).toContainText("not available yet");
  await page.getByRole("button", { name: "Got it" }).click();
  await page.locator("#create").click();
  const input = page.getByRole("textbox", { name: "Ask your data" });
  await expect(input).toBeEnabled({ timeout: 120000 });
  await input.fill("Rename dashboard to Sidebar acceptance");
  await page.getByRole("button", { name: "Send prompt" }).click();
  await expect(
    page.getByRole("heading", { name: "Sidebar acceptance", exact: true }),
  ).toBeVisible();
  const recent = page.getByRole("navigation", { name: "Recent dashboards" });
  await expect(
    recent.getByRole("link", { name: "Sidebar acceptance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page
    .getByRole("button", { name: "About Amazon Web Services source" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Amazon Web Services" }),
  ).toContainText("DynamoDB record access is separately restricted");
  await page.getByRole("button", { name: "Close source details" }).click();
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Add a source" }),
  ).toContainText("not available yet");
  await page.keyboard.press("Escape");
  const id = new URL(page.url()).pathname.split("/")[1];
  const share = await (
    await page.request.post(`/api/sessions/${id}/share`, { data: {} })
  ).json();
  const guest = await browser.newContext(),
    viewer = await guest.newPage();
  await viewer.goto(share.url);
  await expect(
    viewer.getByRole("navigation", { name: "Shared dashboard" }),
  ).toBeVisible();
  await expect(
    viewer.getByRole("navigation", { name: "Recent dashboards" }),
  ).toHaveCount(0);
  await expect(
    viewer.getByRole("button", { name: "Add source", exact: true }),
  ).toHaveCount(0);
  await guest.close();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(
    page.getByRole("button", { name: "Log out", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(
    page.getByLabel("Workspace password", { exact: true }),
  ).toBeVisible();
  expect((await page.request.get("/api/sessions")).status()).toBe(401);
  await page
    .getByLabel("Workspace password", { exact: true })
    .fill("test-only-workspace-password");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page
    .getByRole("navigation", { name: "Recent dashboards" })
    .getByRole("link", { name: "Sidebar acceptance", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Sidebar acceptance", exact: true }),
  ).toBeVisible({ timeout: 120000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "All dashboards", exact: true })
    .click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(
    page.getByLabel("Workspace password", { exact: true }),
  ).toBeVisible();
});

test("dashboard lifecycle: create, question, HMR edits, download, share, restore, restart", async ({
  page,
  browser,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your workspace awaits." }),
  ).toBeVisible();
  await page
    .getByLabel("Workspace password", { exact: true })
    .fill("test-only-workspace-password");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Your living workspace" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/landing-desktop.png",
    fullPage: true,
  });
  await page.locator("#create").click();
  await expect(
    page.getByRole("heading", { name: "What would you like to see?" }),
  ).toBeVisible({ timeout: 120000 });
  const id = new URL(page.url()).pathname.split("/")[1];
  await expect(
    page.getByRole("textbox", { name: "Ask your data" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/session-empty.png",
    fullPage: true,
  });
  const send = async (prompt: string) => {
    await page.getByRole("textbox", { name: "Ask your data" }).fill(prompt);
    await page.getByRole("button", { name: "Send prompt" }).click();
    await expect(
      page.getByRole("textbox", { name: "Ask your data" }),
    ).toBeEnabled({ timeout: 90000 });
  };
  await send("How many users are in signup status?");
  await expect(
    page.getByText("In the demo dataset, 16 users", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What would you like to see?" }),
  ).toBeVisible();
  const before = await (await page.request.get(`/api/sessions/${id}`)).json();
  await send(
    "Add a CPU graph highlighting values over 80% and a log download button",
  );
  await expect(
    page.getByRole("heading", { name: "EC2 CPU utilization" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Application logs" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /CPU utilization over time/ }),
  ).toBeVisible();
  await page.getByLabel("Time window").selectOption("4");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download logs" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/logs-.*\.jsonl/);
  await page.screenshot({
    path: "test-results/session-built.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/session-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const history = await (
    await page.request.get(`/api/sessions/${id}/history`)
  ).json();
  expect(history.length).toBeGreaterThan(1);
  const share = await (
    await page.request.post(`/api/sessions/${id}/share`, { data: {} })
  ).json();
  const guest = await browser.newContext(),
    viewer = await guest.newPage();
  await viewer.goto(share.url);
  await expect(
    viewer.getByRole("heading", { name: "EC2 CPU utilization" }),
  ).toBeVisible();
  await expect(
    viewer.getByRole("textbox", { name: "Ask your data" }),
  ).toBeDisabled();
  expect(
    (
      await viewer.request.post(`/api/sessions/${id}/prompt`, {
        data: { prompt: "delete all" },
      })
    ).status(),
  ).toBe(401);
  expect((await request.get(`/api/sessions/${id}/messages`)).status()).toBe(
    403,
  );
  expect(
    (
      await viewer.request.post(`/api/sessions/${id}/query`, {
        data: {
          connectorId: "aws",
          query: { operation: "table", table: "users", limit: 100 },
        },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await page.request.post(`/api/sessions/${id}/query`, {
        data: {
          connectorId: "aws",
          query: { operation: "cpu", instanceId: "i-denied", hours: 1 },
        },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await page.request.post(`/api/sessions/${id}/share`, {
        headers: { Origin: "https://evil.example" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  await page.request.post(`/api/sessions/${id}/share/revoke`, { data: {} });
  expect((await viewer.request.get(`/api/sessions/${id}`)).status()).toBe(403);
  await guest.close();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Dashboard history" }),
  ).toBeVisible();
  const restored = await page.request.post(`/api/sessions/${id}/restore`, {
    data: { revision: before.revision },
  });
  expect(restored.ok()).toBe(true);
  await page.getByRole("button", { name: "Close history" }).click();
  await expect(
    page.getByRole("heading", { name: "What would you like to see?" }),
  ).toBeVisible();
  const final = await (await page.request.get(`/api/sessions/${id}`)).json();
  expect(final.revision).not.toBe(before.revision);
  await page.request.post(`/api/sessions/${id}/stop`, { data: {} });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "What would you like to see?" }),
  ).toBeVisible({ timeout: 120000 });
  await expect(
    page.getByText("In the demo dataset, 16 users", { exact: false }),
  ).toBeVisible();
});

test("isolated custom 3D interaction, independent scroll, recoverable deletion and revoked shares", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Workspace password", { exact: true })
    .fill("test-only-workspace-password");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.locator("#create").click();
  const prompt = page.getByRole("textbox", { name: "Ask your data" });
  await expect(prompt).toBeEnabled({ timeout: 120000 });
  const id = new URL(page.url()).pathname.split("/")[1];
  await prompt.fill("Build a 3D capacity explorer with arrow key flight");
  await page.getByRole("button", { name: "Send prompt" }).click();
  await expect(prompt).toBeEnabled({ timeout: 90000 });
  await expect(
    page.getByRole("heading", { name: "Demo 3D capacity explorer" }),
  ).toBeVisible();
  await expect(
    page.getByText("Synthetic demo capacity, not measured filesystem usage."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Increment", exact: true }).click();
  await expect(page.locator(".custom-cards strong")).toHaveText("1");
  const canvas = page.locator(".custom-scene canvas");
  const before = await canvas.screenshot();
  await canvas.focus();
  await page.keyboard.down("ArrowUp");
  await expect(canvas).toHaveAttribute("data-moving", "true");
  await page.waitForTimeout(300);
  await page.keyboard.up("ArrowUp");
  const after = await canvas.screenshot();
  expect(before.equals(after)).toBe(false);
  await expect(canvas).toHaveAttribute("data-moving", "false");
  const worker = await page.request.get(`/${id}/custom/worker.mjs`);
  expect(worker.headers()["content-security-policy"]).toContain(
    "connect-src 'none'",
  );
  expect((await page.request.get(`/${id}/custom/runner.mjs`)).status()).toBe(
    404,
  );
  const state = await (await page.request.get(`/api/sessions/${id}`)).json();
  expect(state.dashboard.widgets[0].type).toBe("custom");
  expect(state.revision).toBeTruthy();
  await page.screenshot({
    path: "test-results/custom-3d-desktop.png",
    fullPage: true,
  });
  // Make the conversation long enough to scroll without adding AI costs.
  await page.evaluate(() => {
    const el = document.querySelector(".messages")!;
    const p = document.createElement("p");
    p.textContent = "Conversation history. ".repeat(500);
    el.append(p);
  });
  const position = await page
    .locator(".dashboard-content")
    .evaluate((el) => el.scrollTop);
  await page.locator(".messages").hover();
  await page.mouse.wheel(0, 500);
  expect(
    await page.locator(".dashboard-content").evaluate((el) => el.scrollTop),
  ).toBe(position);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(prompt).toBeVisible();
  const panes = await page.locator(".dashboard-content").boundingBox();
  expect(panes!.height).toBeGreaterThan(180);
  await page.screenshot({
    path: "test-results/custom-3d-mobile.png",
    fullPage: true,
  });
  const share = await (
    await page.request.post(`/api/sessions/${id}/share`, { data: {} })
  ).json();
  const guest = await browser.newContext(),
    viewer = await guest.newPage();
  await viewer.goto(share.url);
  await expect(
    viewer.getByRole("button", { name: "Increment", exact: true }),
  ).toBeVisible();
  expect(
    (
      await viewer.request.post(`/api/sessions/${id}/delete`, { data: {} })
    ).status(),
  ).toBe(401);
  expect(
    (
      await viewer.request.post(
        `/api/sessions/${id}/custom/custom-capacity/data`,
        { data: { query: { operation: "table", table: "private" } } },
      )
    ).status(),
  ).toBe(400);
  expect(
    (await page.request.post(`/api/sessions/${id}/delete`, { data: {} })).ok(),
  ).toBe(true);
  expect((await page.request.get(`/api/sessions/${id}`)).status()).toBe(404);
  expect((await viewer.request.get(`/api/sessions/${id}`)).status()).toBe(403);
  expect(
    (
      await page.request.post("/api/sessions/import", { data: { id } })
    ).status(),
  ).toBe(409);
  const trash = await (await page.request.get("/api/trash")).json();
  expect(trash.some((s: any) => s.id === id)).toBe(true);
  expect(
    (await page.request.post(`/api/trash/${id}/restore`, { data: {} })).ok(),
  ).toBe(true);
  expect((await viewer.request.get(`/api/sessions/${id}`)).status()).toBe(403);
  const restored = await (await page.request.get(`/api/sessions/${id}`)).json();
  expect(restored.revision).toBe(state.revision);
  await guest.close();
});
