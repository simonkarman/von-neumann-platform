import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { dashboardSchema, querySchema } from "../server/schema.js";
import { migrateDashboard } from "../server/dashboard-migration.js";
const { evaluate, validateOutput } = await import(
  pathToFileURL(path.resolve("dashboard-base/public/custom/engine.mjs")).href
);
test("custom interpreter has no ambient browser, Node, network or host escape APIs", async () => {
  const result = await evaluate(
    `function render(){return {view:{text:JSON.stringify([typeof fetch,typeof XMLHttpRequest,typeof WebSocket,typeof document,typeof window,typeof process,typeof require,typeof importScripts,typeof Worker,typeof WebAssembly,Function('return typeof process')(),({}).constructor.constructor('return typeof fetch')()])}}}`,
    { data: {} },
  );
  assert.deepEqual(JSON.parse(result.view.text), Array(12).fill("undefined"));
});
test("custom code preserves bounded state, but cannot retain globals across runs", async () => {
  const source =
    'globalThis.calls=(globalThis.calls||0)+1; function render({state,event}){return {state:{n:(state?.n||0)+(event?.id==="increment"?1:0)},view:{text:String(globalThis.calls)}}}';
  const first = await evaluate(source, { data: {}, state: null, event: null });
  const second = await evaluate(source, {
    data: {},
    state: first.state,
    event: { id: "increment" },
  });
  assert.equal(second.state.n, 1);
  assert.equal(second.view.text, "1");
});
test("runaway code, recursion, memory growth, imports and oversized output fail closed", async () => {
  for (const source of [
    "function render(){while(true){}}",
    "function render(){return render()}",
    "function render(){const a=[];for(;;)a.push(new Array(10000).fill(1))}",
    'import x from "node:fs";function render(){return {view:{}}}',
    'function render(){return {view:{text:"x".repeat(200000)}}}',
    'function render(){return {view:{text: fetch("https://example.com")}}}',
  ])
    await assert.rejects(evaluate(source, { data: {} }));
});
test("render contract rejects exfiltration, host props, styles, malformed geometry and oversized scenes", () => {
  for (const view of [
    { html: "<script>run()</script>" },
    { src: "https://example.com" },
    { style: { background: "url(https://example.com)" } },
    { cards: [{ label: "x", value: "1", color: "url(https://example.com)" }] },
    { controls: [{ id: "x", label: "X", onclick: "alert(1)" }] },
    { scene: { boxes: Array(251).fill({}) } },
    {
      scene: {
        boxes: [
          {
            id: "x",
            label: "X",
            x: Infinity,
            y: 0,
            z: 0,
            width: 1,
            height: 1,
            depth: 1,
          },
        ],
      },
    },
    { table: { columns: ["a"], rows: [["a", "b"]] } },
  ])
    assert.throws(() => validateOutput({ view }));
  assert.equal(
    validateOutput({ view: { text: "<script>inert plain text</script>" } }).view
      .text,
    "<script>inert plain text</script>",
  );
});
test("multi-resource charts have individual queries; legacy CSV dimensions migrate safely", () => {
  const query = {
    operation: "aws_metric",
    service: "ec2",
    metric: "CPUUtilization",
    resourceId: "i-00000000000000001,i-00000000000000002",
    hours: 24,
  };
  assert.equal(querySchema.safeParse(query).success, false);
  const raw = {
    title: "CPU",
    widgets: [{ id: "cpu", type: "chart", title: "CPU", query }],
  };
  const migrated = dashboardSchema.parse(migrateDashboard(raw));
  assert.equal(migrated.widgets[0].series?.length, 2);
  assert.equal(migrated.widgets[0].query, undefined);
  assert.equal(raw.widgets[0].query.resourceId, query.resourceId);
});
test("custom widget bindings are bounded and cannot smuggle arbitrary queries", () => {
  for (const bindings of [
    [{ id: "x", query: { operation: "exec" } }],
    Array(5).fill({ id: "x", query: { operation: "instances" } }),
  ])
    assert.equal(
      dashboardSchema.safeParse({
        title: "x",
        widgets: [
          {
            id: "custom",
            type: "custom",
            title: "x",
            custom: { source: "function render(){}", bindings },
          },
        ],
      }).success,
      false,
    );
});
