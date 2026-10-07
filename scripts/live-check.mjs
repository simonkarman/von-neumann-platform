import "dotenv/config";
import assert from "node:assert/strict";
const base = process.env.CHECK_URL || "http://localhost:3001";
let cookie = "";
async function request(path, body) {
  return fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(path, body) {
  const response = await request(path, body);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
const login = await request("/api/auth/login", {
  password: process.env.ADMIN_PASSWORD || "",
});
assert.ok(login.ok, "login succeeded");
cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
const configuration = await json("/api/config");
assert.equal(configuration.mode, "demo", "Smoke test must use sample AWS data");
const session = await json("/api/sessions", {});
console.log(`Created ${session.id} using ${configuration.provider}`);
const deadline = Date.now() + 120000;
while (true) {
  const state = await json(`/api/sessions/${session.id}`);
  if (state.status === "ready") break;
  if (state.status === "failed") throw new Error(state.error);
  if (Date.now() > deadline) throw new Error("Startup timed out");
  await new Promise((resolve) => setTimeout(resolve, 500));
}
async function prompt(text) {
  const response = await request(`/api/sessions/${session.id}/prompt`, {
    prompt: text,
  });
  assert.ok(response.ok);
  const stream = await response.text();
  const events = stream
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  const error = events.find((e) => e.type === "error");
  if (error) throw new Error(error.message);
  const answer = events
    .filter((e) => e.type === "delta")
    .map((e) => e.text)
    .join("");
  assert.ok(answer.length > 0, "assistant returned text");
  return answer;
}
const answer = await prompt(
  "How many users are in signup status in the configured users table? Use the data connector.",
);
assert.match(answer, /16/, "model called connector and returned correct count");
assert.equal(
  (await json(`/api/sessions/${session.id}`)).dashboard.widgets.length,
  0,
  "data question did not alter dashboard",
);
console.log("Data question answered correctly without UI mutation.");
await prompt(
  "Add a CPU chart for i-demo-api over 24 hours, highlighting values above 60%, and a log download card for /von-neumann/api with 1-hour and 4-hour choices. Name the dashboard Cloud operations.",
);
const updated = await json(`/api/sessions/${session.id}`);
assert.ok(
  updated.dashboard.widgets.some(
    (w) => w.type === "chart" && w.threshold === 60,
  ),
  "chart was generated",
);
assert.ok(
  updated.dashboard.widgets.some((w) => w.type === "logs"),
  "log downloader was generated",
);
assert.notEqual(updated.revision, session.revision);
assert.ok(
  (await json(`/api/sessions/${session.id}/history`)).length > 1,
  "Git commit created",
);
console.log(
  `Model-driven dashboard edit saved and synchronized: ${updated.revision.slice(0, 7)} (${updated.syncStatus}).`,
);
console.log(`Dashboard: ${base}/${session.id}`);
if (process.env.CHECK_STOP === "true")
  await json(`/api/sessions/${session.id}/stop`, {});
