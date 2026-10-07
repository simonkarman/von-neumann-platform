import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
type Git = (cwd: string, ...args: string[]) => Promise<string>;
const hash = (content: Buffer) =>
  createHash("sha256").update(content).digest("hex");
async function readOptional(file: string) {
  try {
    return await readFile(file);
  } catch (error: any) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
// Only shipped, known template versions are upgraded; arbitrary session files never are.
export async function upgradeTemplate(dir: string, template: string, git: Git) {
  const manifestName = "template-version.json";
  const raw = await readOptional(path.join(template, manifestName));
  if (!raw) return false;
  const manifest = JSON.parse(raw.toString()) as {
    version: number;
    files: Record<string, string[]>;
  };
  const current = await readOptional(path.join(dir, manifestName));
  if (current && JSON.parse(current.toString()).version >= manifest.version)
    return false;
  const changes: { file: string; old?: Buffer; next: Buffer }[] = [];
  for (const [file, previousHashes] of Object.entries(manifest.files)) {
    if (path.isAbsolute(file) || file.split("/").includes(".."))
      throw new Error("Invalid template migration path");
    const old = await readOptional(path.join(dir, file));
    const next = await readFile(path.join(template, file));
    if (old?.equals(next)) continue;
    if (!previousHashes.includes(old ? hash(old) : "missing"))
      throw new Error(
        `Template upgrade blocked: customized ${file}. Your files were preserved.`,
      );
    changes.push({ file, old, next });
  }
  changes.push({ file: manifestName, old: current, next: raw });
  const paths = changes.map((c) => c.file);
  if (await git(dir, "status", "--porcelain", "--", ...paths))
    throw new Error(
      "Template upgrade blocked by uncommitted component changes. Your files were preserved.",
    );
  try {
    for (const change of changes) {
      await mkdir(path.dirname(path.join(dir, change.file)), {
        recursive: true,
      });
      await writeFile(path.join(dir, change.file), change.next);
    }
    await git(dir, "add", "--", ...paths);
    await git(
      dir,
      "commit",
      "--only",
      "-m",
      `Upgrade trusted dashboard components to template v${manifest.version}`,
      "--",
      ...paths,
    );
  } catch (error) {
    for (const change of changes) {
      const file = path.join(dir, change.file);
      if (change.old) await writeFile(file, change.old);
      else await unlink(file).catch(() => {});
    }
    await git(dir, "reset", "--", ...paths);
    throw error;
  }
  // A failed push remains visible as pending sync in prepareWorkspace.
  await git(dir, "push", "origin", "HEAD").catch(() => {});
  return true;
}
