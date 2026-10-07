// Trusted interpreter bridge. User source is evaluated ONLY by QuickJS/WASM,
// never eval/Function, Node, React, or the surrounding worker's JS engine.
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-browser-release-sync";

export const MAX_OUTPUT = 160000;
const fail = (message) => {
  throw new Error(message);
};
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
function fields(x, allowed) {
  if (!object(x) || Object.keys(x).some((k) => !allowed.includes(k)))
    fail("Unsupported view fields");
}
function text(x, max = 500) {
  if (typeof x !== "string" || x.length > max)
    fail("Invalid or oversized text");
}
function list(x, max) {
  if (!Array.isArray(x) || x.length > max) fail("Invalid or oversized list");
}
function number(x, min = -10000, max = 10000) {
  if (!Number.isFinite(x) || x < min || x > max)
    fail("Number outside rendering bounds");
}
function color(x) {
  if (x !== undefined && !/^#[0-9a-f]{6}$/i.test(x))
    fail("Colors must be six-digit hex");
}

// The ONLY bridge out of the interpreter is inert, size-bounded JSON.
// No URLs, HTML, styles, event-handler strings, shaders, or arbitrary props.
export function validateOutput(output) {
  if (JSON.stringify(output).length > MAX_OUTPUT)
    fail("Custom widget output is too large");
  fields(output, ["state", "view"]);
  if (JSON.stringify(output.state ?? null).length > 16000)
    fail("Custom state is too large");
  const v = output.view;
  fields(v, ["title", "text", "cards", "bars", "table", "scene", "controls"]);
  if (v.title !== undefined) text(v.title, 120);
  if (v.text !== undefined) text(v.text, 4000);
  for (const key of ["cards", "bars", "controls"])
    if (v[key] !== undefined) {
      list(v[key], key === "controls" ? 12 : 100);
      for (const row of v[key]) {
        fields(
          row,
          key === "controls" ? ["id", "label"] : ["label", "value", "color"],
        );
        text(row.label, 120);
        if (key === "controls") {
          text(row.id, 48);
          if (!/^[a-z][a-z0-9-]*$/.test(row.id)) fail("Invalid control ID");
        } else {
          color(row.color);
          if (key === "bars") number(row.value, 0, 1e15);
          else text(row.value, 200);
        }
      }
      if (
        key === "controls" &&
        new Set(v[key].map((x) => x.id)).size !== v[key].length
      )
        fail("Duplicate controls");
    }
  if (v.table !== undefined) {
    fields(v.table, ["columns", "rows"]);
    list(v.table.columns, 16);
    v.table.columns.forEach((x) => text(x, 120));
    list(v.table.rows, 200);
    v.table.rows.forEach((row) => {
      list(row, 16);
      if (row.length !== v.table.columns.length) fail("Table column mismatch");
      row.forEach((x) => text(x, 500));
    });
  }
  if (v.scene !== undefined) {
    fields(v.scene, ["boxes"]);
    list(v.scene.boxes, 250);
    v.scene.boxes.forEach((box) => {
      fields(box, [
        "id",
        "label",
        "x",
        "y",
        "z",
        "width",
        "height",
        "depth",
        "color",
      ]);
      text(box.id, 80);
      text(box.label, 120);
      color(box.color);
      ["x", "y", "z"].forEach((k) => number(box[k]));
      ["width", "height", "depth"].forEach((k) => number(box[k], 0.01, 1000));
    });
  }
  return output;
}

export async function evaluate(source, input) {
  if (typeof source !== "string" || source.length > 30000)
    fail("Source limit exceeded");
  const encoded = JSON.stringify(input);
  if (encoded.length > 250000)
    fail("Input limit exceeded; reduce data bindings");
  // A fresh WASM module/runtime per invocation: no retained globals between widgets.
  const module = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(8 * 1024 * 1024);
  runtime.setMaxStackSize(128 * 1024);
  const deadline = Date.now() + 200;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  try {
    const result = context.evalCode(
      `"use strict";\n${source}\n;JSON.stringify(render(JSON.parse(${JSON.stringify(encoded)})))`,
      "widget.js",
    );
    if (result.error) {
      result.error.dispose();
      fail(
        "Custom code failed (syntax/runtime error, time or memory limit). Use synchronous function render(input), returning {state,view}.",
      );
    }
    try {
      if (context.typeof(result.value) !== "string")
        fail("render must return JSON-serializable {state,view}");
      const json = context.getString(result.value);
      if (json.length > MAX_OUTPUT) fail("Output limit exceeded");
      return validateOutput(JSON.parse(json));
    } finally {
      result.value.dispose();
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
