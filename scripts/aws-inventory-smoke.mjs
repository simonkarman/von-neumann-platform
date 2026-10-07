// Opt-in live verification: consumes two model requests; secrets remain in memory.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
const state = JSON.parse(readFileSync(".data/aws-deployment.json", "utf8"));
const password = JSON.parse(
  execFileSync(
    "aws",
    [
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      state.AdminPasswordArn,
      "--profile",
      state.profile,
      "--region",
      state.region,
    ],
    { encoding: "utf8" },
  ),
).SecretString;
let cookie = "";
const request = (path, body) =>
  fetch(state.Url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(270000),
  });
async function json(path, body) {
  const r = await request(path, body);
  const v = await r.json();
  assert.ok(r.ok, v.error || `HTTP ${r.status}`);
  return v;
}
const login = await request("/api/auth/login", { password });
assert.ok(login.ok);
cookie = login.headers.get("set-cookie").split(";")[0];
const connector = (await json("/api/connectors"))[0];
assert.equal(connector.access.inventory, true);
assert.equal(
  connector.access.tableRecords,
  "explicit table allowlist only; inventory does not grant record access",
);
console.log(
  `Connector: ${connector.capabilities.length} operations in ${connector.regions.length} regions`,
);
async function ready(id) {
  const until = Date.now() + 180000;
  for (;;) {
    const s = await json(`/api/sessions/${id}`);
    if (s.status === "ready") return s;
    if (s.status === "failed") throw new Error(s.error);
    if (Date.now() > until) throw new Error("Session startup timed out");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
// Check a dashboard created by the previous deployment without changing its widgets.
const previousId = process.env.CHECK_PREVIOUS_SESSION_ID;
if (previousId) {
  const old = await json(`/api/sessions/${previousId}`);
  await json(`/api/sessions/${previousId}/start`, {});
  const migrated = await ready(previousId);
  assert.deepEqual(migrated.dashboard, old.dashboard);
  assert.ok(
    (await json(`/api/sessions/${previousId}/history`)).some((h) =>
      h.title.includes("template v2"),
    ),
  );
  console.log("Existing dashboard migrated; layout and history preserved.");
}
const session = process.env.CHECK_SESSION_ID
  ? await json(`/api/sessions/${process.env.CHECK_SESSION_ID}`)
  : await json("/api/sessions", {});
writeFileSync(
  ".data/inventory-smoke-session.json",
  JSON.stringify(
    { id: session.id, url: `${state.Url}/${session.id}` },
    null,
    2,
  ),
);
await json(`/api/sessions/${session.id}/start`, {});
await ready(session.id);
console.log(`Inventory dashboard: ${state.Url}/${session.id}`);
const query = (q) =>
  json(`/api/sessions/${session.id}/query`, { connectorId: "aws", query: q });
const all = await query({
  operation: "cloudformation_resources",
  region: "all",
  limit: 10000,
});
assert.ok(all.items.length > 0);
assert.equal(all.truncated, false);
assert.deepEqual(all.errors, []);
console.log(
  `CloudFormation: ${all.items.length} resources across ${Object.keys(all.countsByStack).length} stacks`,
);
const instances = await query({ operation: "instances", region: state.region });
const instanceId = process.env.CHECK_INSTANCE_ID || state.InstanceId;
assert.ok(instances.items.some((i) => i.id === instanceId));
const cpu = await query({
  operation: "cpu",
  instanceId,
  hours: 24,
  region: state.region,
});
assert.ok(cpu.points.length > 0);
console.log(
  `Previously rejected instance: ${cpu.points.length} real CPU samples`,
);
const skip = new Set([
  "instances",
  "cpu",
  "log_groups",
  "logs",
  "table",
  "aws_metric",
  "cloudformation_resources",
  "dynamodb_details",
  "ecs_services",
  "ecs_tasks",
  "eks_nodegroups",
  "step_function_executions",
  "ecr_images",
]);
for (const operation of connector.capabilities.filter((o) => !skip.has(o))) {
  const resourceId =
    operation === "log_streams"
      ? state.LogGroup
      : operation === "route53_records"
        ? state.HostedZoneId
        : undefined;
  const r = await query({
    operation,
    limit: 20,
    hours: 1,
    ...(resourceId ? { resourceId } : {}),
  });
  assert.deepEqual(r.errors, [], `${operation}: ${JSON.stringify(r.errors)}`);
  console.log(`${operation}: ${r.items.length} rows`);
}
const logs = await query({ operation: "log_groups" });
const external = logs.items.find((l) => l.name !== state.LogGroup);
if (external) {
  await query({
    operation: "logs",
    logGroup: external.name,
    hours: 1,
    limit: 1,
  });
  console.log("Non-platform log group read authorized (contents not printed).");
}
assert.equal(
  (
    await request(`/api/sessions/${session.id}/query`, {
      connectorId: "aws",
      query: { operation: "table", table: "not-allowlisted" },
    })
  ).status,
  409,
);
async function prompt(text) {
  const r = await request(`/api/sessions/${session.id}/prompt`, {
    prompt: text,
  });
  assert.ok(r.ok);
  const events = (await r.text())
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
  assert.deepEqual(
    events.filter((e) => e.type === "error"),
    [],
  );
  // Repeated runs may correctly leave an already matching widget unchanged.
  // The saved specification assertions below verify the actual requested outcome.
}
await prompt(
  "Can you add a table showing all resources across the different AWS CloudFormation stacks? Group it by stack and show counts. Include all enabled regions.",
);
let updated = await json(`/api/sessions/${session.id}`);
assert.ok(
  updated.dashboard.widgets.some(
    (w) =>
      w.type === "table" &&
      w.query?.operation === "cloudformation_resources" &&
      w.query.region === "all",
  ),
);
await prompt(
  `Also add a CPU usage graph for instance ${instanceId} in ${state.region} for the last 24 hours. Keep the CloudFormation resources table.`,
);
updated = await json(`/api/sessions/${session.id}`);
assert.ok(
  updated.dashboard.widgets.some(
    (w) =>
      w.type === "table" && w.query?.operation === "cloudformation_resources",
  ),
);
assert.ok(
  updated.dashboard.widgets.some(
    (w) =>
      w.type === "chart" &&
      (w.query.instanceId || w.query.resourceId) === instanceId &&
      w.query.region === state.region,
  ),
);
console.log(
  `Bedrock generated both widgets and committed ${updated.revision.slice(0, 7)}`,
);
const saved = cookie;
cookie = "";
assert.equal((await request("/api/connectors")).status, 401);
assert.equal(
  (
    await request(`/api/sessions/${session.id}/query`, {
      connectorId: "aws",
      query: { operation: "instances" },
    })
  ).status,
  403,
);
cookie = saved;
const share = await json(`/api/sessions/${session.id}/share`, {});
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const [name, value] = cookie.split("=");
  await context.addCookies([
    {
      name,
      value,
      domain: new URL(state.Url).hostname,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${state.Url}/${session.id}`);
  await page.getByLabel("Search table").waitFor({ timeout: 120000 });
  await page.locator("tbody tr").first().waitFor();
  assert.ok((await page.locator("tbody tr").count()) > 0);
  await page
    .getByLabel("Search table")
    .fill(state.ApplicationStack || "von-neumann-application");
  assert.ok((await page.locator("tbody tr").count()) > 0);
  await page.getByLabel("Search table").fill("");
  if (all.items.length > 25) {
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByText(/page 2 of/).waitFor();
  }
  await page.getByRole("textbox", { name: "Ask your data" }).waitFor();
  await page.screenshot({
    path: "test-results/aws-inventory.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  const guest = await browser.newContext(),
    viewer = await guest.newPage();
  await viewer.goto(share.url);
  await viewer.getByLabel("Search table").waitFor({ timeout: 120000 });
  const denied = await viewer.request.post(
    `${state.Url}/api/sessions/${session.id}/query`,
    { data: { connectorId: "aws", query: { operation: "secrets_metadata" } } },
  );
  assert.equal(denied.status(), 409);
  const deniedEdit = await viewer.request.post(
    `${state.Url}/api/sessions/${session.id}/prompt`,
    { data: { prompt: "change it" } },
  );
  assert.equal(deniedEdit.status(), 401);
  await json(`/api/sessions/${session.id}/share/revoke`, {});
  console.log(
    "Browser rendering, table search/pagination, mobile layout, anonymous blocking and viewer scope verified.",
  );
} finally {
  await browser.close();
}
console.log(`PASS ${state.Url}/${session.id}`);
