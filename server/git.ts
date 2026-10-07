import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  access,
  cp,
} from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import {
  sessionId,
  dashboardSchema,
  generateDashboard,
  type Dashboard,
} from "./schema.js";
import { store } from "./store.js";
import { upgradeTemplate } from "./template-upgrade.js";
import { migrateDashboard } from "./dashboard-migration.js";
const exec = promisify(execFile);
export const workspace = (id: string) =>
  path.join(config.DATA_DIR, "sessions", sessionId.parse(id));
export async function git(cwd: string, ...args: string[]) {
  const r = await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Von Neumann",
      GIT_AUTHOR_EMAIL: "dashboard@localhost",
      GIT_COMMITTER_NAME: "Von Neumann",
      GIT_COMMITTER_EMAIL: "dashboard@localhost",
    },
  });
  return r.stdout.trim();
}
export async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
let initialized: Promise<string> | undefined;
export function repository() {
  return (initialized ||= (async () => {
    if (config.DASHBOARD_REPO_URL) return config.DASHBOARD_REPO_URL;
    const bare = path.join(config.DATA_DIR, "dashboard.git");
    if (!(await exists(bare))) {
      const seed = path.join(config.DATA_DIR, "template-seed");
      await cp(config.DASHBOARD_TEMPLATE_DIR, seed, {
        recursive: true,
        filter: (source) =>
          !["node_modules", ".git", ".next", ".env"].includes(
            path.basename(source),
          ),
      });
      await git(seed, "init", "-b", "main");
      await git(seed, "add", ".");
      await git(seed, "commit", "-m", "Initialize empty dashboard template");
      await git(config.DATA_DIR, "clone", "--bare", seed, bare);
    }
    return bare;
  })().catch((error) => {
    initialized = undefined;
    throw error;
  }));
}
export async function prepareWorkspace(id: string, restore = false) {
  const dir = workspace(id),
    remote = await repository();
  if (!(await exists(path.join(dir, ".git")))) {
    await mkdir(path.dirname(dir), { recursive: true });
    const branch = `session/${id}`;
    const existsRemote = await git(
      config.DATA_DIR,
      "ls-remote",
      "--heads",
      remote,
      `refs/heads/${branch}`,
    );
    if (restore && !existsRemote)
      throw new Error(
        "Session branch does not exist in the dashboard repository.",
      );
    await git(
      config.DATA_DIR,
      "clone",
      ...(existsRemote ? ["--branch", branch] : []),
      "--",
      remote,
      dir,
    );
    if (!existsRemote) {
      await git(dir, "checkout", "-b", branch);
      await git(dir, "push", "-u", "origin", branch);
    }
  }
  await upgradeTemplate(dir, config.DASHBOARD_TEMPLATE_DIR, git);
  // JSON is the recovery source. Recreate generated TSX from validated data before starting Next.
  const original = JSON.parse(
    await readFile(path.join(dir, "dashboard.json"), "utf8"),
  );
  const migrated = migrateDashboard(original);
  const spec = dashboardSchema.parse(migrated);
  await writeFile(
    path.join(dir, "src/generated/Dashboard.tsx"),
    generateDashboard(spec),
  );
  if (JSON.stringify(original) !== JSON.stringify(migrated)) {
    await writeFile(
      path.join(dir, "dashboard.json"),
      JSON.stringify(spec, null, 2) + "\n",
    );
    await git(
      dir,
      "add",
      "--",
      "dashboard.json",
      "src/generated/Dashboard.tsx",
    );
    await git(
      dir,
      "commit",
      "--only",
      "-m",
      "Repair legacy multi-instance chart dimensions",
      "--",
      "dashboard.json",
      "src/generated/Dashboard.tsx",
    );
    await git(dir, "push", "origin", "HEAD").catch(() => {});
  }
  const revision = await git(dir, "rev-parse", "HEAD");
  let syncStatus = config.DASHBOARD_REPO_URL ? "synced" : "local";
  try {
    const remoteRevision = await git(
      dir,
      "rev-parse",
      `refs/remotes/origin/session/${id}`,
    );
    if (remoteRevision !== revision) syncStatus = "pending";
  } catch {
    syncStatus = "pending";
  }
  store.update(id, spec, revision, syncStatus);
  return dir;
}
export async function commitDashboard(
  id: string,
  dashboard: Dashboard,
  summary: string,
) {
  const dir = workspace(id),
    previous = store.get(id)!;
  const source = generateDashboard(dashboard);
  const specPath = path.join(dir, "dashboard.json"),
    sourcePath = path.join(dir, "src/generated/Dashboard.tsx");
  const oldSpec = await readFile(specPath, "utf8"),
    oldSource = await readFile(sourcePath, "utf8");
  try {
    await writeFile(
      specPath + ".tmp",
      JSON.stringify(dashboard, null, 2) + "\n",
    );
    await rename(specPath + ".tmp", specPath);
    await writeFile(sourcePath + ".tmp", source);
    await rename(sourcePath + ".tmp", sourcePath);
    // A structural validator checks the complete spec before any write. TypeScript verifies the generated component.
    const tsc = path.join(
      config.DASHBOARD_TEMPLATE_DIR,
      "node_modules/typescript/bin/tsc",
    );
    if (config.RUNTIME_DRIVER === "process")
      await exec(
        process.execPath,
        [tsc, "--noEmit", "--incremental", "false"],
        { cwd: dir, timeout: 60000, maxBuffer: 200000 },
      );
    else
      await exec(
        "docker",
        [
          "exec",
          `vn-${id}`,
          "node",
          "/opt/template/node_modules/typescript/bin/tsc",
          "--noEmit",
          "--incremental",
          "false",
        ],
        { timeout: 60000, maxBuffer: 200000 },
      );
    await git(
      dir,
      "add",
      "--",
      "dashboard.json",
      "src/generated/Dashboard.tsx",
    );
    const diff = await git(dir, "diff", "--cached", "--name-only", '--', 'dashboard.json', 'src/generated/Dashboard.tsx');
    if (diff) await git(dir, "commit", '--only', "-m", summary.slice(0, 160), '--', 'dashboard.json', 'src/generated/Dashboard.tsx');
  } catch (error) {
    await writeFile(specPath, oldSpec);
    await writeFile(sourcePath, oldSource);
    await git(
      dir,
      "add",
      "--",
      "dashboard.json",
      "src/generated/Dashboard.tsx",
    );
    throw new Error("Dashboard change failed validation and was rolled back.", {
      cause: error,
    });
  }
  const revision = await git(dir, "rev-parse", "HEAD");
  let syncStatus = config.DASHBOARD_REPO_URL ? "synced" : "local";
  try {
    await git(dir, "push", "origin", `HEAD:refs/heads/session/${id}`);
  } catch {
    syncStatus = "pending";
  }
  store.update(id, dashboard, revision, syncStatus);
  store.audit(id, "dashboard.commit", {
    revision,
    previous: previous.revision,
    syncStatus,
  });
  return { revision, syncStatus };
}
export async function history(id: string) {
  const log = await git(
    workspace(id),
    "log",
    "-30",
    "--format=%H%x09%aI%x09%s",
  );
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [revision, createdAt, ...title] = line.split("\t");
      return { revision, createdAt, title: title.join("\t") };
    });
}
export async function restoreRevision(id: string, revision: string) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid revision");
  const entries = await history(id);
  if (!entries.some((e) => e.revision === revision))
    throw new Error("Revision is not in this session history.");
  const spec = dashboardSchema.parse(
    migrateDashboard(
      JSON.parse(
        await git(workspace(id), "show", `${revision}:dashboard.json`),
      ),
    ),
  );
  return commitDashboard(
    id,
    spec,
    `Restore dashboard to ${revision.slice(0, 8)}`,
  );
}
export async function retrySync(id: string) {
  await git(workspace(id), "push", "origin", `HEAD:refs/heads/session/${id}`);
  const s = store.get(id)!;
  store.update(
    id,
    s.dashboard,
    s.revision!,
    config.DASHBOARD_REPO_URL ? "synced" : "local",
  );
}
