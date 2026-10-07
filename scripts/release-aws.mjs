// Roll out code without changing/replacing the EC2 instance or credentials.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { assertProjectEnabled } from "./project-guard.mjs";
import { expectedAccount } from "./deployment-config.mjs";
const state = JSON.parse(readFileSync(".data/aws-deployment.json", "utf8"));
const identity = JSON.parse(
  execFileSync(
    "aws",
    [
      "sts",
      "get-caller-identity",
      "--profile",
      state.profile,
      "--region",
      state.region,
      "--output",
      "json",
    ],
    { encoding: "utf8" },
  ),
);
if (identity.Account !== expectedAccount(state))
  throw new Error("Wrong AWS account; release refused");
assertProjectEnabled(state);
const archive = ".data/releases/update.tar.gz";
execFileSync("tar", [
  "--exclude=node_modules",
  "--exclude=.git",
  "--exclude=.next",
  "--exclude=*.tsbuildinfo",
  "--exclude=.DS_Store",
  "--exclude=.env*",
  "--exclude=.data",
  "--exclude=.aws",
  "--exclude=.runtime-home",
  "--exclude=*.pem",
  "--exclude=*.key",
  "--exclude=*.p12",
  "--exclude=*.pfx",
  "--exclude=id_rsa*",
  "--exclude=id_ed25519*",
  "--exclude=*.log",
  "--exclude=*.bind",
  "--exclude=*credentials*.json",
  "--exclude=*service-account*.json",
  "-czf",
  archive,
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "Dockerfile",
  "Dockerfile.session",
  ".dockerignore",
  "server",
  "web",
  "dashboard-base",
  "deploy",
  "scripts",
  "tests",
]);
const hash = createHash("sha256")
  .update(readFileSync(archive))
  .digest("hex")
  .slice(0, 20);
const key = `releases/${hash}.tar.gz`;
execFileSync(
  "aws",
  [
    "s3",
    "cp",
    archive,
    `s3://${state.ArtifactBucket}/${key}`,
    "--profile",
    state.profile,
    "--region",
    state.region,
    "--only-show-errors",
  ],
  { stdio: "inherit" },
);
const command = `set -eu; for attempt in $(seq 1 120); do test -f /var/lib/von-neumann-ready && break; sleep 5; done; test -f /var/lib/von-neumann-ready; cd /opt/von-neumann; aws s3 cp s3://${state.ArtifactBucket}/${key} /opt/von-neumann/update.tar.gz --region ${state.region} --only-show-errors; tar -xzf update.tar.gz; bash deploy/aws/upgrade.sh`;
execFileSync(process.execPath, ["scripts/aws-command.mjs", command], {
  stdio: "inherit",
});
state.ArtifactKey = key;
writeFileSync(
  ".data/aws-deployment.json",
  JSON.stringify(state, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(`Deployed ${key}`);
