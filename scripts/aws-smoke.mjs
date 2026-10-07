import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import dns from "node:dns";
const state = JSON.parse(readFileSync(".data/aws-deployment.json", "utf8"));
// Optional test-only bypass of a stale local DNS cache. TLS certificate and
// hostname validation remain enabled; public DNS is checked separately.
const hostname = new URL(state.Url).hostname;
if (process.env.CHECK_RESOLVE_IP) {
  const lookup = dns.lookup;
  dns.lookup = (host, options, callback) => {
    if (host !== hostname) return lookup(host, options, callback);
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    process.nextTick(() =>
      options?.all
        ? callback(null, [{ address: state.PublicIp, family: 4 }])
        : callback(null, state.PublicIp, 4),
    );
  };
}
// Keep the password in memory only; never put it in argv, logs or test artifacts.
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
async function request(path, body) {
  return fetch(state.Url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(240000),
  });
}
async function json(path, body) {
  const response = await request(path, body);
  const value = await response.json();
  assert.ok(response.ok, value.error || `HTTP ${response.status}`);
  return value;
}
const login = await request("/api/auth/login", { password });
assert.ok(login.ok, "HTTPS login succeeded");
cookie = login.headers.get("set-cookie").split(";")[0];
const configuration = await json("/api/config");
assert.equal(configuration.provider, "bedrock");
assert.equal(configuration.mode, "live");
const connector = (await json("/api/connectors"))[0];
assert.ok(connector.resources.instances.includes(state.InstanceId));
const session = await json("/api/sessions", {});
console.log(`Created live AWS dashboard ${session.id}`);
const deadline = Date.now() + 180000;
while ((await json(`/api/sessions/${session.id}`)).status !== "ready") {
  if (Date.now() > deadline) throw new Error("Session failed to start");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const response = await request(`/api/sessions/${session.id}/prompt`, {
  prompt: `Build a dashboard named AWS deployment with a 24-hour CPU chart for ${state.InstanceId}, highlighting above 60%, and a log-download card for ${state.LogGroup}. Use the real AWS connector. Read the CPU data to confirm access first.`,
});
assert.ok(response.ok);
const events = (await response.text())
  .split("\n")
  .filter((line) => line.startsWith("data: "))
  .map((line) => JSON.parse(line.slice(6)));
assert.equal(
  events.find((e) => e.type === "error"),
  undefined,
  JSON.stringify(events.filter((e) => e.type === "error")),
);
const updated = await json(`/api/sessions/${session.id}`);
assert.ok(updated.dashboard.widgets.some((w) => w.type === "chart"));
assert.ok(updated.dashboard.widgets.some((w) => w.type === "logs"));
assert.ok((await json(`/api/sessions/${session.id}/history`)).length > 1);
const savedCookie = cookie;
cookie = "";
assert.equal((await request("/api/sessions", {})).status, 401);
assert.equal((await request("/api/connectors")).status, 401);
assert.equal(
  (await request(`/api/sessions/${session.id}/prompt`, { prompt: "hello" }))
    .status,
  403,
);
assert.equal(
  (
    await request(`/api/sessions/${session.id}/query`, {
      connectorId: "aws",
      query: { operation: "instances" },
    })
  ).status,
  403,
);
cookie = savedCookie;
console.log(
  "Anonymous session creation, connector access, model calls and data queries rejected.",
);
console.log(
  `Bedrock + live AWS + Git verified: ${updated.revision.slice(0, 7)}`,
);
const browser = await chromium.launch({
  args: process.env.CHECK_RESOLVE_IP
    ? [`--host-resolver-rules=MAP ${hostname} ${state.PublicIp}`]
    : [],
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const [name, value] = cookie.split("=");
  await context.addCookies([
    {
      name,
      value,
      domain: hostname,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${state.Url}/${session.id}`);
  await page.getByRole("textbox", { name: "Ask your data" }).waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector('textarea[aria-label="Ask your data"]')?.disabled,
  );
  await page.getByRole("button", { name: "Download logs" }).waitFor();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download logs" }).click();
  const download = await downloadPromise;
  assert.equal(await download.failure(), null);
  await page.screenshot({ path: "test-results/aws-deployment.png" });
  assert.deepEqual(errors, []);
  console.log(
    `HTTPS browser, hydration and real log download verified: ${state.Url}/${session.id}`,
  );
} finally {
  await browser.close();
}
