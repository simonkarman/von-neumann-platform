// Run an operator-supplied, non-secret command on this deployment through SSM.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expectedAccount } from "./deployment-config.mjs";
const state = JSON.parse(readFileSync(".data/aws-deployment.json", "utf8"));
const command = process.argv[2];
if (!command)
  throw new Error(
    "Usage: node scripts/aws-command.mjs 'shell command' (never include secrets)",
  );
const aws = (args) =>
  JSON.parse(
    execFileSync(
      "aws",
      [...args, "--profile", state.profile, "--region", state.region],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    ),
  );
if (aws(["sts", "get-caller-identity"]).Account !== expectedAccount(state))
  throw new Error("Wrong AWS account; SSM command refused");
const sent = aws([
  "ssm",
  "send-command",
  "--instance-ids",
  state.InstanceId,
  "--document-name",
  "AWS-RunShellScript",
  "--parameters",
  JSON.stringify({ commands: [command], executionTimeout: ["1800"] }),
]);
const id = sent.Command.CommandId;
console.log(`SSM command ${id}`);
let last = "";
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  let result;
  try {
    result = aws([
      "ssm",
      "get-command-invocation",
      "--command-id",
      id,
      "--instance-id",
      state.InstanceId,
    ]);
  } catch {
    continue;
  }
  if (result.Status !== last) console.log(result.Status);
  last = result.Status;
  if (["Pending", "InProgress", "Delayed"].includes(result.Status)) continue;
  if (result.StandardOutputContent) console.log(result.StandardOutputContent);
  if (result.StandardErrorContent) console.error(result.StandardErrorContent);
  if (result.Status !== "Success") process.exitCode = 1;
  break;
}
