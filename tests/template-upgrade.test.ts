import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { upgradeTemplate } from "../server/template-upgrade.js";
const git = async (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
test("template upgrades preserve dashboard/history, are idempotent, and reject custom files before writing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vn-upgrade-"));
  const template = path.join(root, "template"),
    dir = path.join(root, "session");
  await mkdir(template);
  await mkdir(dir);
  const original = "old trusted component";
  await writeFile(path.join(template, "component.ts"), "new trusted component");
  await writeFile(
    path.join(template, "template-version.json"),
    JSON.stringify({
      version: 2,
      files: {
        "component.ts": [createHash("sha256").update(original).digest("hex")],
      },
    }),
  );
  await writeFile(path.join(dir, "component.ts"), original);
  await writeFile(
    path.join(dir, "dashboard.json"),
    '{"title":"User dashboard"}',
  );
  await git(dir, "init", "-b", "main");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "Original");
  const before = await git(dir, "rev-parse", "HEAD");
  await writeFile(path.join(dir, "component.ts"), "customized");
  await assert.rejects(upgradeTemplate(dir, template, git), /customized/);
  assert.equal(
    await readFile(path.join(dir, "component.ts"), "utf8"),
    "customized",
  );
  await writeFile(path.join(dir, "component.ts"), original);
  assert.equal(await upgradeTemplate(dir, template, git), true);
  assert.equal(await git(dir, "rev-parse", "HEAD^"), before);
  assert.equal(
    await readFile(path.join(dir, "dashboard.json"), "utf8"),
    '{"title":"User dashboard"}',
  );
  assert.equal(
    await readFile(path.join(dir, "component.ts"), "utf8"),
    "new trusted component",
  );
  assert.equal(await upgradeTemplate(dir, template, git), false);
  assert.equal(await git(dir, "status", "--porcelain"), "");
});
