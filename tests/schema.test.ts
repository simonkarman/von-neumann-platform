import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dashboardSchema,
  generateDashboard,
  querySchema,
  sessionId,
} from "../server/schema.js";
import { AwsConnector, redact } from "../server/connectors.js";

test("session IDs cannot become paths or Git options", () => {
  for (const bad of [
    "../../etc",
    "--upload-pack=evil",
    "main",
    "a".repeat(25),
    "a".repeat(23) + "/",
  ])
    assert.equal(sessionId.safeParse(bad).success, false);
  assert.equal(sessionId.safeParse("a".repeat(24)).success, true);
});
test("query validation rejects arbitrary commands, oversized scans and hidden properties", () => {
  for (const query of [
    { operation: "exec", command: "x" },
    { operation: "table", table: "x", limit: 1001 },
    { operation: "logs", logGroup: "x", hours: 25 },
    { operation: "instances", region: "unapproved" },
  ])
    assert.equal(querySchema.safeParse(query).success, false);
});
test("dashboard generator treats hostile text as a literal, not executable JSX", () => {
  const content = '</script><script>alert(1)</script>";process.exit();//';
  const code = generateDashboard({
    title: "Test",
    widgets: [{ id: "note", type: "text", title: "Note", content }],
  });
  assert.ok(code.includes(JSON.stringify(content)));
  assert.equal((code.match(/import /g) || []).length, 2);
  assert.throws(() =>
    dashboardSchema.parse({
      title: "Test",
      widgets: [{ id: "../escape", type: "text", title: "x" }],
    }),
  );
});
test("duplicate widgets and mismatched data widgets are rejected before a code write", () => {
  const w = { id: "same", type: "text", title: "test" };
  assert.equal(
    dashboardSchema.safeParse({ title: "Test", widgets: [w, w] }).success,
    false,
  );
  assert.equal(
    dashboardSchema.safeParse({
      title: "Test",
      widgets: [
        {
          id: "chart",
          type: "chart",
          title: "x",
          query: { operation: "instances" },
        },
      ],
    }).success,
    false,
  );
});
test("AWS resource restrictions are enforced before any network call", async () => {
  const connector = new AwsConnector("live", {
    instances: ["i-allowed"],
    logGroups: ["/allowed"],
    tables: ["allowed"],
  });
  await assert.rejects(
    connector.query({ operation: "cpu", instanceId: "i-denied", hours: 1 }),
    /allowlist/,
  );
  await assert.rejects(
    connector.query({
      operation: "logs",
      logGroup: "/denied",
      hours: 1,
      filter: "",
      limit: 100,
    }),
    /allowlist/,
  );
  await assert.rejects(
    connector.query({ operation: "table", table: "denied", limit: 100 }),
    /allowlist/,
  );
});
test("sampled counts and demo measurements cannot silently masquerade as complete live results", async () => {
  const connector = new AwsConnector("demo");
  const count = await connector.query({
    operation: "table",
    table: "users",
    limit: 5,
  });
  assert.equal(count.mode, "demo");
  assert.equal(count.truncated, true);
  assert.match(count.countScope, /sample/);
  const metric = await connector.query({
    operation: "cpu",
    instanceId: "i-demo-api",
    hours: 1,
  });
  assert.equal(metric.mode, "demo");
  assert.equal(metric.points.length, 96);
  assert.ok(metric.points.every((p: any) => p.value >= 0 && p.value <= 100));
});
test("known credential patterns are redacted", () => {
  assert.equal(redact("token=long-sensitive-value"), "token=[REDACTED]");
});
