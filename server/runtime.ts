import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, symlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import net from "node:net";
import path from "node:path";
import { config } from "./config.js";
import { prepareWorkspace, exists, workspace } from "./git.js";
import { store } from "./store.js";
const exec = promisify(execFile);
type Runtime = {
  target: string;
  process?: ChildProcess;
  touched: number;
  ready: boolean;
};
const active = new Map<string, Runtime>(),
  starting = new Map<string, Promise<Runtime>>();
export const busy = new Set<string>();
let shuttingDown = false;
export async function exclusive<T>(id: string, action: () => Promise<T>) {
  if (busy.has(id))
    throw new Error(
      "Another change is running for this dashboard. Try again when it finishes.",
    );
  busy.add(id);
  try {
    return await action();
  } finally {
    busy.delete(id);
  }
}
async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}
export function peekRuntime(id: string) {
  const r = active.get(id);
  if (r) r.touched = Date.now();
  return r?.ready ? r : undefined;
}
export async function ensureRuntime(
  id: string,
  restore = false,
): Promise<Runtime> {
  if (shuttingDown) throw new Error("Server is shutting down.");
  if (!store.get(id)) throw new Error("Dashboard is missing or in Trash");
  const pending = starting.get(id);
  if (pending) return pending;
  const existing = peekRuntime(id);
  if (existing) return existing;
  if (
    new Set([...active.keys(), ...starting.keys()]).size >=
    config.MAX_ACTIVE_SESSIONS
  ) {
    store.status(
      id,
      "failed",
      "All session slots are in use. Stop an idle session and try again.",
    );
    throw new Error(
      "All session slots are in use. Stop an idle session and try again.",
    );
  }
  const promise = start(id, restore);
  starting.set(id, promise);
  try {
    return await promise;
  } finally {
    starting.delete(id);
  }
}
async function start(id: string, restore: boolean) {
  store.status(id, "starting");
  let runtime: Runtime | undefined;
  try {
    const dir = await prepareWorkspace(id, restore);
    const host = new URL(config.PUBLIC_URL).hostname;
    if (config.RUNTIME_DRIVER === "process") {
      // A shared, lockfile-pinned dependency installation keeps session startup fast.
      const modules = path.join(dir, "node_modules");
      if (!(await exists(modules)))
        await symlink(
          path.join(config.DASHBOARD_TEMPLATE_DIR, "node_modules"),
          modules,
          "dir",
        );
      const home = path.join(dir, ".runtime-home");
      await mkdir(home, { recursive: true });
      const port = await freePort();
      const child = spawn(
        process.execPath,
        [
          path.join(dir, "node_modules/next/dist/bin/next"),
          "dev",
          "--webpack",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: process.env.TMPDIR || "/tmp",
            NODE_ENV: "development",
            NEXT_TELEMETRY_DISABLED: "1",
            WATCHPACK_POLLING: "1000",
            SESSION_ID: id,
            PUBLIC_HOST: host,
            NODE_OPTIONS: "--max-old-space-size=768",
          },
        },
      );
      runtime = {
        target: `http://127.0.0.1:${port}`,
        process: child,
        touched: Date.now(),
        ready: false,
      };
      const log = createWriteStream(
        path.join(config.DATA_DIR, `runtime-${id}.log`),
        { flags: "a", mode: 0o600 },
      );
      child.stdout?.pipe(log, { end: false });
      child.stderr?.pipe(log, { end: false });
      child.once("exit", () => log.end());
      child.on("error", () => {
        active.delete(id);
        store.status(id, "failed", "Dashboard process could not start.");
      });
      child.on("exit", () => {
        if (active.get(id)?.process === child) {
          active.delete(id);
          store.status(id, "stopped");
        }
      });
    } else {
      const hostPath = path.join(config.SESSION_HOST_ROOT, "sessions", id);
      const mount = config.SESSION_VOLUME
        ? `type=volume,source=${config.SESSION_VOLUME},target=/workspace,volume-subpath=sessions/${id}`
        : `type=bind,src=${hostPath},dst=/workspace`;
      // Only this session's workspace is mounted; no cloud keys, API keys, or Docker socket.
      let adopt = false;
      try {
        const inspected = await exec(
          "docker",
          ["inspect", "--format", "{{json .}}", `vn-${id}`],
          { timeout: 10000 },
        );
        const existing = JSON.parse(inspected.stdout);
        if (
          existing.Config?.Labels?.["io.von-neumann.session"] !== id ||
          !existing.Mounts?.some(
            (m: any) =>
              (config.SESSION_VOLUME
                ? m.Name === config.SESSION_VOLUME
                : m.Source === hostPath) && m.Destination === "/workspace",
          )
        )
          throw new Error(
            "Existing container does not belong to this session.",
          );
        if (!existing.State?.Running)
          throw new Error(
            "Existing session container is not running. Stop it before retrying.",
          );
        adopt = true;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error)) throw error;
        // docker inspect exits nonzero if this session has no container yet.
      }
      if (!adopt)
        await exec(
          "docker",
          [
            "run",
            "-d",
            "--rm",
            "--name",
            `vn-${id}`,
            "--label",
            `io.von-neumann.session=${id}`,
            "--network",
            config.SESSION_DOCKER_NETWORK,
            "--memory",
            "1g",
            "--cpus",
            "1",
            "--pids-limit",
            "128",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=128m",
            "--user",
            "1000:1000",
            "--mount",
            mount,
            "-e",
            `SESSION_ID=${id}`,
            "-e",
            `PUBLIC_HOST=${host}`,
            config.SESSION_IMAGE,
          ],
          { timeout: 60000 },
        );
      runtime = {
        target: `http://vn-${id}:3000`,
        touched: Date.now(),
        ready: false,
      };
    }
    active.set(id, runtime);
    const deadline = Date.now() + config.SESSION_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!active.has(id))
        throw new Error("Dashboard runtime exited during startup.");
      try {
        const r = await fetch(`${runtime.target}/${id}`, {
          signal: AbortSignal.timeout(1000),
        });
        if (r.ok) {
          runtime.ready = true;
          store.status(id, "ready");
          store.audit(id, "session.started", { driver: config.RUNTIME_DRIVER });
          return runtime;
        }
      } catch {
        /* runtime is compiling */
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    throw new Error(
      "Dashboard startup timed out. Check template dependencies and runtime configuration.",
    );
  } catch (error) {
    await stopRuntime(id);
    store.status(
      id,
      "failed",
      error instanceof Error ? error.message : "Session startup failed.",
    );
    throw error;
  }
}
export async function settleAndStopRuntime(id: string) {
  await starting.get(id)?.catch(() => {});
  await stopRuntime(id);
}
export async function stopRuntime(id: string) {
  const r = active.get(id);
  active.delete(id);
  if (r?.process) {
    r.process.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => r.process!.once("exit", () => resolve())),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          r.process!.kill("SIGKILL");
          resolve();
        }, 3000),
      ),
    ]);
  }
  // Only stop runtimes we started or verified and adopted. A conflicting
  // container name must never authorize stopping somebody else's container.
  if (config.RUNTIME_DRIVER === "docker" && r) {
    try {
      await exec("docker", ["stop", "-t", "3", `vn-${id}`], { timeout: 10000 });
    } catch {
      /* already stopped */
    }
  }
  if (store.get(id)) store.status(id, "stopped");
}
export async function shutdown() {
  shuttingDown = true;
  await Promise.allSettled([...starting.values()]);
  await Promise.all([...active.keys()].map(stopRuntime));
}
export const idleTimer = setInterval(() => {
  for (const [id, runtime] of active)
    if (
      !starting.has(id) &&
      !busy.has(id) &&
      Date.now() - runtime.touched > config.SESSION_IDLE_MINUTES * 60000
    )
      void stopRuntime(id);
}, 60000);
idleTimer.unref();
