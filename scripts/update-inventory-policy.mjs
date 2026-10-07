// Refuse any change other than a non-replacing IAM role update.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expectedAccount } from "./deployment-config.mjs";
import { assertProjectEnabled } from "./project-guard.mjs";
const s = JSON.parse(readFileSync(".data/aws-deployment.json", "utf8"));
const aws = (args) => {
  const output = execFileSync(
    "aws",
    [...args, "--profile", s.profile, "--region", s.region, "--output", "json"],
    { encoding: "utf8" },
  );
  return output.trim() ? JSON.parse(output) : {};
};
if (aws(["sts", "get-caller-identity"]).Account !== expectedAccount(s))
  throw new Error("Wrong AWS account");
assertProjectEnabled(s);
const stack = s.ApplicationStack || "von-neumann-application";
const current = aws([
  "cloudformation",
  "describe-stacks",
  "--stack-name",
  stack,
]).Stacks[0];
const name = `inventory-${Date.now()}`;
aws([
  "cloudformation",
  "create-change-set",
  "--stack-name",
  stack,
  "--change-set-name",
  name,
  "--template-body",
  "file://deploy/cloudformation/application.yaml",
  "--parameters",
  JSON.stringify(
    current.Parameters.map((p) => ({
      ParameterKey: p.ParameterKey,
      UsePreviousValue: true,
    })),
  ),
  "--capabilities",
  "CAPABILITY_IAM",
]);
let changes;
for (;;) {
  changes = aws([
    "cloudformation",
    "describe-change-set",
    "--stack-name",
    stack,
    "--change-set-name",
    name,
  ]);
  if (changes.Status === "CREATE_COMPLETE") break;
  if (changes.Status === "FAILED") throw new Error(changes.StatusReason);
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(
  JSON.stringify(
    changes.Changes.map((c) => c.ResourceChange),
    null,
    2,
  ),
);
if (
  !changes.Changes.length ||
  changes.Changes.some(
    (c) =>
      c.ResourceChange.LogicalResourceId !== "Role" ||
      c.ResourceChange.Action !== "Modify" ||
      c.ResourceChange.Replacement !== "False",
  )
)
  throw new Error(
    "Refusing deployment: change set includes more than the in-place IAM Role update. Review manually.",
  );
aws([
  "cloudformation",
  "execute-change-set",
  "--stack-name",
  stack,
  "--change-set-name",
  name,
]);
for (;;) {
  const status = aws([
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    stack,
  ]).Stacks[0].StackStatus;
  if (status === "UPDATE_COMPLETE") break;
  if (status.includes("ROLLBACK") || status.includes("FAILED"))
    throw new Error(status);
  await new Promise((r) => setTimeout(r, 5000));
}
console.log(
  "Read-only inventory IAM policy deployed; no compute/storage replacement.",
);
