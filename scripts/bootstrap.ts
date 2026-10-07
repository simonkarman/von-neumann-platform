import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
const template = path.resolve("dashboard-base");
if (!existsSync(path.join(template, "package.json")))
  throw new Error(
    "Clone the base-dashboard repository into dashboard-base first.",
  );
if (!existsSync(path.join(template, ".git"))) {
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: template,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Von Neumann",
        GIT_AUTHOR_EMAIL: "dashboard@localhost",
        GIT_COMMITTER_NAME: "Von Neumann",
        GIT_COMMITTER_EMAIL: "dashboard@localhost",
      },
    });
  git("init", "-b", "main");
  git("add", ".");
  git("commit", "-m", "Initialize versioned Next.js dashboard template");
}
await mkdir(".data", { recursive: true, mode: 0o700 });
if (!existsSync(".env")) {
  const example = await readFile(".env.example", "utf8");
  const content = example
    .replace(
      "ADMIN_PASSWORD=\n",
      `ADMIN_PASSWORD=${randomBytes(18).toString("base64url")}\n`,
    )
    .replace(
      "SESSION_SECRET=\n",
      `SESSION_SECRET=${randomBytes(32).toString("hex")}\n`,
    )
    .replace(
      "SESSION_HOST_ROOT=\n",
      `SESSION_HOST_ROOT="${path.resolve(".data")}"\n`,
    );
  await writeFile(".env", content, { mode: 0o600, flag: "wx" });
  console.log(
    "Created .env with a random workspace password and session secret. Read ADMIN_PASSWORD locally to sign in.",
  );
}
console.log(
  "Two repositories are ready: this infrastructure checkout and dashboard-base/. Configure .env, then npm run dev.",
);
