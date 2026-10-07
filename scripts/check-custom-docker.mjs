import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "vn-custom-docker-"));
process.env.RUNTIME_DRIVER = "docker";
process.env.SESSION_IMAGE ||= "von-neumann-session:hybrid-test";
process.env.AWS_MODE = "demo";
process.env.VN_SANDBOX_CANARY = "must-not-cross-runtime-boundary";
const { testCustomWidget } = await import("../server/custom.ts");
const { widgetSchema } = await import("../server/schema.ts");
const widget = (source) =>
  widgetSchema.parse({
    id: "sandbox-check",
    type: "custom",
    title: "Sandbox check",
    custom: { source, bindings: [] },
  });
const result = await testCustomWidget(
  widget(
    `function render(){return {view:{text:JSON.stringify([typeof process,typeof fetch,typeof require,typeof document]),controls:[{id:'test',label:'Test'}]}}}`,
  ),
);
assert.deepEqual(
  JSON.parse(result.result.view.text),
  Array(4).fill("undefined"),
);
assert.equal(result.checks.length, 3);
await assert.rejects(
  testCustomWidget(widget("function render(){while(true){}}")),
);
await assert.rejects(
  testCustomWidget(
    widget('function render(){return {view:{html:"<script>unsafe</script>"}}}'),
  ),
);
console.log(
  "PASS: production-style isolated Docker execution, declared controls, absent host APIs, runaway interruption, invalid-output rejection.",
);
