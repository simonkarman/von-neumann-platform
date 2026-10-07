import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { config } from "./config.js";
import { getConnector } from "./connectors.js";
import type { Widget } from "./schema.js";

// No arbitrary commands, filenames, mounts, environment or dependency installation.
export async function testCustomWidget(widget: Widget) {
  if (widget.type !== "custom" || !widget.custom)
    throw new Error("Custom widget required");
  const data: Record<string, unknown> = {};
  for (const binding of widget.custom.bindings)
    data[binding.id] = await getConnector(widget.connectorId).query(
      binding.query,
    );
  const payload = JSON.stringify({
    source: widget.custom.source,
    input: { data, state: null, event: null },
  });
  if (payload.length > 300000)
    throw new Error("Custom data exceeds 300 KB; reduce query limits");
  const docker = config.RUNTIME_DRIVER === "docker";
  if (!docker && config.NODE_ENV === "production")
    throw new Error("Production custom validation requires Docker isolation");
  const command = docker ? "docker" : process.execPath;
  const container = `vn-check-${randomBytes(12).toString("hex")}`;
  const args = docker
    ? [
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--memory=128m",
        "--memory-swap=128m",
        "--cpus=.5",
        "--pids-limit=32",
        "--user=65534:65534",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        "--entrypoint=node",
        config.SESSION_IMAGE,
        "--max-old-space-size=48",
        "/opt/custom/runner.mjs",
      ]
    : [
        "--max-old-space-size=48",
        path.join(config.DASHBOARD_TEMPLATE_DIR, "public/custom/runner.mjs"),
      ];
  return await new Promise<any>((resolve, reject) => {
    if (docker) args.splice(1, 0, "--name", container);
    const child = spawn(command, args, {
      env: docker ? { PATH: process.env.PATH } : {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const kill = () => {
      child.kill("SIGKILL");
      if (docker)
        execFile(
          "docker",
          ["rm", "-f", container],
          { timeout: 10000 },
          () => {},
        );
    };
    const timer = setTimeout(() => {
      kill();
      finish(new Error("Custom validation exceeded its 15 second limit"));
    }, 15000);
    child.on("error", (error) => finish(error));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 200000) {
        kill();
        finish(new Error("Custom output limit exceeded"));
      }
    });
    child.stderr.resume(); // Never expose host/container diagnostics containing paths to the model.
    child.on("close", (code) => {
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.error)
          finish(new Error(result.error || "Custom validation failed"));
        else finish(undefined, result);
      } catch {
        finish(
          new Error(
            "Custom validator failed to start or returned invalid output",
          ),
        );
      }
    });
    child.stdin.end(payload);
  });
}
