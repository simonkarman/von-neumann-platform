import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-ignore Operator script is deliberately dependency-free JavaScript.
import {
  installSwitch,
  assertSafeChanges,
  control,
} from "../scripts/project-control.mjs";
const template = readFileSync("deploy/cloudformation/application.yaml", "utf8");
// Historical migration deliberately accepts only the original deployment shape.
// Keep a fixed fixture rather than deriving old YAML from new template formatting.
const original = `Parameters:
  Domain: {Type: String}
Resources:
  SecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      SecurityGroupIngress:
        - {IpProtocol: tcp, FromPort: 80, ToPort: 80, CidrIp: 0.0.0.0/0}
        - {IpProtocol: tcp, FromPort: 443, ToPort: 443, CidrIp: 0.0.0.0/0}
  Role:
    Type: AWS::IAM::Role
    Properties:
      Policies:
        - PolicyName: application
`;
test("legacy kill-switch migration is idempotent and current templates are preserved", () => {
  const migrated = installSwitch(original);
  assert.match(migrated, /ProjectEnabled:/);
  assert.match(migrated, /SecurityGroupIngress: !If/);
  assert.match(migrated, /PolicyName: project-disabled/);
  assert.equal(installSwitch(migrated), migrated);
  assert.equal(installSwitch(template), template);
  assert.throws(
    () => installSwitch("Parameters:\nResources:\n"),
    /structure changed/,
  );
});
test("change-set guard refuses host replacement, deletions and unrelated resources", () => {
  for (const resource of ["Host", "DataVolume", "Ip", "Dns", "BackupRole"])
    assert.throws(() =>
      assertSafeChanges([
        {
          ResourceChange: {
            LogicalResourceId: resource,
            Action: "Modify",
            Replacement: "False",
          },
        },
      ]),
    );
  for (const action of ["Add", "Remove"])
    assert.throws(() =>
      assertSafeChanges([
        {
          ResourceChange: {
            LogicalResourceId: "Role",
            Action: action,
            Replacement: "False",
          },
        },
      ]),
    );
  for (const replacement of ["True", "Conditional"])
    assert.throws(() =>
      assertSafeChanges([
        {
          ResourceChange: {
            LogicalResourceId: "SecurityGroup",
            Action: "Modify",
            Replacement: replacement,
          },
        },
      ]),
    );
  assert.doesNotThrow(() =>
    assertSafeChanges([
      {
        ResourceChange: {
          LogicalResourceId: "Role",
          Action: "Modify",
          Replacement: "False",
        },
      },
    ]),
  );
});
function fixture() {
  let power = "running",
    enabled = true,
    requested = true,
    executing = false;
  const calls: string[][] = [];
  const state = {
    InstanceId: "i-project",
    InstanceRoleArn: "arn:aws:iam::111122223333:role/project",
    Url: "https://dashboard.example",
  };
  const aws = (args: string[]) => {
    calls.push(args);
    const command = args.slice(0, 2).join(" ");
    switch (command) {
      case "sts get-caller-identity":
        return { Account: "111122223333" };
      case "cloudformation describe-stack-resources":
        return {
          StackResources: [
            ["Host", "i-project"],
            ["Role", "project"],
            ["SecurityGroup", "sg-project"],
          ].map(([LogicalResourceId, PhysicalResourceId]) => ({
            LogicalResourceId,
            PhysicalResourceId,
          })),
        };
      case "ec2 describe-instances":
        return {
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: "i-project",
                  State: { Name: power },
                  SecurityGroups: [{ GroupId: "sg-project" }],
                  IamInstanceProfile: { Arn: "profile" },
                },
              ],
            },
          ],
        };
      case "ec2 describe-network-interfaces":
        return {
          NetworkInterfaces: [{ Attachment: { InstanceId: "i-project" } }],
        };
      case "iam list-instance-profiles-for-role":
        return { InstanceProfiles: [{ Arn: "profile" }] };
      case "cloudformation describe-stacks":
        return {
          Stacks: [
            {
              StackStatus: "UPDATE_COMPLETE",
              LastUpdatedTime: String(
                calls.filter((c) => c[1] === "execute-change-set").length,
              ),
              Parameters: [
                {
                  ParameterKey: "ProjectEnabled",
                  ParameterValue: String(enabled),
                },
                { ParameterKey: "ImageId", ParameterValue: "old-ami" },
              ],
            },
          ],
        };
      case "cloudformation get-template":
        return { TemplateBody: template };
      case "cloudformation create-change-set":
        requested =
          JSON.parse(args[args.indexOf("--parameters") + 1]).find(
            (p: any) => p.ParameterKey === "ProjectEnabled",
          ).ParameterValue === "true";
        executing = false;
        return {};
      case "cloudformation describe-change-set":
        return {
          Status: "CREATE_COMPLETE",
          ExecutionStatus: executing ? "EXECUTE_COMPLETE" : "AVAILABLE",
          Changes: [
            {
              ResourceChange: {
                LogicalResourceId: "Role",
                Action: "Modify",
                Replacement: "False",
              },
            },
          ],
        };
      case "cloudformation execute-change-set":
        enabled = requested;
        executing = true;
        return {};
      case "cloudformation delete-change-set":
        return {};
      case "ec2 stop-instances":
        power = "stopped";
        return {};
      case "ec2 start-instances":
        power = "running";
        return {};
      case "ec2 describe-security-groups":
        return { SecurityGroups: [{ IpPermissions: enabled ? [{}, {}] : [] }] };
      case "iam list-role-policies":
        return { PolicyNames: enabled ? [] : ["project-disabled"] };
      case "iam get-role-policy":
        return {
          PolicyDocument: {
            Statement: [{ Effect: "Deny", Action: "*", Resource: "*" }],
          },
        };
      default:
        throw new Error(`Unexpected AWS call: ${command}`);
    }
  };
  return { state, aws, calls };
}
test("disable stops compute first, closes IAM/network, is idempotent, and status never mutates", async () => {
  const f = fixture();
  const result = await control("disable", f.state, f.aws, { pollMs: 0 });
  assert.equal(result.disabled, true);
  assert.ok(
    f.calls.findIndex((c) => c[1] === "stop-instances") <
      f.calls.findIndex((c) => c[1] === "execute-change-set"),
  );
  f.calls.length = 0;
  await control("disable", f.state, f.aws, { pollMs: 0 });
  assert.ok(
    !f.calls.some((c) =>
      ["stop-instances", "create-change-set", "execute-change-set"].includes(
        c[1],
      ),
    ),
  );
  f.calls.length = 0;
  await control("status", f.state, f.aws);
  assert.ok(f.calls.every((c) => /^(get|describe|list)/.test(c[1])));
});
test("enable preview never executes or starts; enable restores permissions before starting", async () => {
  const f = fixture();
  await control("disable", f.state, f.aws, { pollMs: 0 });
  f.calls.length = 0;
  await control("plan-enable", f.state, f.aws, { pollMs: 0 });
  assert.ok(
    !f.calls.some((c) =>
      ["start-instances", "execute-change-set"].includes(c[1]),
    ),
  );
  const fetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{"ok":true}', { status: 200 })) as typeof fetch;
  try {
    f.calls.length = 0;
    const result = await control("enable", f.state, f.aws, { pollMs: 0 });
    assert.equal(result.projectEnabled, "true");
    assert.equal(result.instanceState, "running");
    assert.ok(
      f.calls.findIndex((c) => c[1] === "execute-change-set") <
        f.calls.findIndex((c) => c[1] === "start-instances"),
    );
  } finally {
    globalThis.fetch = fetch;
  }
});
test("wrong account is refused before any mutation", async () => {
  await assert.rejects(control("disable", {}, {}, {}));
  const calls: any[] = [];
  await assert.rejects(
    control("disable", { AccountId: "111122223333" }, (args: any) => {
      calls.push(args);
      return { Account: "other" };
    }),
    /Wrong AWS account/,
  );
  assert.equal(calls.length, 1);
});
test("lifecycle uses the configured application stack", async () => {
  const f = fixture();
  await control(
    "status",
    { ...f.state, ApplicationStack: "research-application" },
    f.aws,
  );
  const stackCalls = f.calls.filter((c) => c.includes("--stack-name"));
  assert.ok(stackCalls.length > 0);
  assert.ok(
    stackCalls.every(
      (c) => c[c.indexOf("--stack-name") + 1] === "research-application",
    ),
  );
});
