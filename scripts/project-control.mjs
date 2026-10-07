import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { expectedAccount } from "./deployment-config.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Install only the kill switch into the CURRENT deployed template. Do not deploy
// unrelated local template changes, change the AMI, replace EC2, or replace disks.
export function installSwitch(template) {
  if (typeof template !== "string")
    throw new Error("Expected the deployed YAML template");
  if (/^  ProjectEnabled:/m.test(template)) return template;
  const ingress =
    "      SecurityGroupIngress:\n        - {IpProtocol: tcp, FromPort: 80, ToPort: 80, CidrIp: 0.0.0.0/0}\n        - {IpProtocol: tcp, FromPort: 443, ToPort: 443, CidrIp: 0.0.0.0/0}";
  if (
    !template.includes(ingress) ||
    template.includes("\nConditions:") ||
    (template.match(/^      Policies:/gm) || []).length !== 1
  )
    throw new Error(
      "Template structure changed; refusing an unsafe automatic migration",
    );
  return template
    .replace(
      "Parameters:\n",
      "Parameters:\n  ProjectEnabled:\n    Type: String\n    Default: 'true'\n    AllowedValues: ['true', 'false']\n    Description: Security kill switch. False closes ingress and denies all application-role AWS access; use project:disable to also stop EC2.\n",
    )
    .replace(
      "Resources:\n",
      "Conditions:\n  ProjectIsEnabled: !Equals [!Ref ProjectEnabled, 'true']\nResources:\n",
    )
    .replace(
      ingress,
      "      SecurityGroupIngress: !If\n        - ProjectIsEnabled\n        - - {IpProtocol: tcp, FromPort: 80, ToPort: 80, CidrIp: 0.0.0.0/0}\n          - {IpProtocol: tcp, FromPort: 443, ToPort: 443, CidrIp: 0.0.0.0/0}\n        - []",
    )
    .replace(
      "      Policies:\n",
      "      Policies:\n        - !If\n          - ProjectIsEnabled\n          - !Ref AWS::NoValue\n          - PolicyName: project-disabled\n            PolicyDocument:\n              Version: '2012-10-17'\n              Statement: [{Effect: Deny, Action: '*', Resource: '*'}]\n",
    );
}

export function assertSafeChanges(changes) {
  if (
    changes.some(
      ({ ResourceChange: c }) =>
        !["SecurityGroup", "Role"].includes(c?.LogicalResourceId) ||
        c.Action !== "Modify" ||
        c.Replacement !== "False",
    )
  )
    throw new Error(
      "Refusing change set: only non-replacing SecurityGroup/Role changes are permitted. Nothing was executed.",
    );
}

export async function control(action, state, aws, options = {}) {
  const STACK = state.ApplicationStack || "von-neumann-application";
  if (!["enable", "disable", "status", "plan-enable"].includes(action))
    throw new Error("Use enable, disable, status or plan-enable");
  const identity = aws(["sts", "get-caller-identity"]);
  if (identity.Account !== expectedAccount(state))
    throw new Error("Wrong AWS account; no changes made");
  const stack = () =>
    aws(["cloudformation", "describe-stacks", "--stack-name", STACK]).Stacks[0];
  const resources = Object.fromEntries(
    aws([
      "cloudformation",
      "describe-stack-resources",
      "--stack-name",
      STACK,
    ]).StackResources.map((r) => [r.LogicalResourceId, r.PhysicalResourceId]),
  );
  if (
    resources.Host !== state.InstanceId ||
    resources.Role !== state.InstanceRoleArn.split("/").at(-1)
  )
    throw new Error("Deployment state does not match stack resources");
  const instance = () =>
    aws(["ec2", "describe-instances", "--instance-ids", resources.Host])
      .Reservations[0].Instances[0];
  const original = instance();
  if (
    original.SecurityGroups.length !== 1 ||
    original.SecurityGroups[0].GroupId !== resources.SecurityGroup
  )
    throw new Error(
      "Unexpected instance security groups; inspect before changing access",
    );
  const attached = aws([
    "ec2",
    "describe-network-interfaces",
    "--filters",
    `Name=group-id,Values=${resources.SecurityGroup}`,
  ]).NetworkInterfaces;
  if (attached.some((n) => n.Attachment?.InstanceId !== resources.Host))
    throw new Error(
      "Security group is shared with another resource; refusing changes",
    );
  const profiles = aws([
    "iam",
    "list-instance-profiles-for-role",
    "--role-name",
    resources.Role,
  ]).InstanceProfiles;
  if (
    profiles.length !== 1 ||
    profiles[0].Arn !== original.IamInstanceProfile?.Arn
  )
    throw new Error("Role is not exclusive to the expected instance profile");
  const roleUsers = aws([
    "ec2",
    "describe-instances",
    "--filters",
    `Name=iam-instance-profile.arn,Values=${original.IamInstanceProfile.Arn}`,
  ]).Reservations.flatMap((r) => r.Instances);
  if (
    roleUsers.some(
      (i) => i.InstanceId !== resources.Host && i.State.Name !== "terminated",
    )
  )
    throw new Error(
      "Another instance uses the application role; refusing changes",
    );
  const waitFor = async (check, label, timeout = 600000) => {
    const deadline = Date.now() + timeout;
    while (!(await check())) {
      if (Date.now() > deadline)
        throw new Error(`${label} timed out; run project:status`);
      await sleep(options.pollMs ?? 3000);
    }
  };
  const stop = async () => {
    const current = instance().State.Name;
    if (["running", "pending"].includes(current))
      aws(["ec2", "stop-instances", "--instance-ids", resources.Host]);
    else if (!["stopped", "stopping"].includes(current))
      throw new Error(`Unexpected instance state ${current}`);
  };
  const update = async (enabled, preview = false) => {
    const current = stack();
    if (
      ![
        "CREATE_COMPLETE",
        "UPDATE_COMPLETE",
        "UPDATE_ROLLBACK_COMPLETE",
      ].includes(current.StackStatus)
    )
      throw new Error(`Stack is not ready: ${current.StackStatus}`);
    const raw = aws([
      "cloudformation",
      "get-template",
      "--stack-name",
      STACK,
      "--template-stage",
      "Original",
    ]).TemplateBody;
    const template = installSwitch(raw);
    const existing = current.Parameters.find(
      (p) => p.ParameterKey === "ProjectEnabled",
    );
    if (existing?.ParameterValue === String(enabled) && raw === template)
      return;
    const parameters = current.Parameters.filter(
      (p) => p.ParameterKey !== "ProjectEnabled",
    ).map((p) => ({ ParameterKey: p.ParameterKey, UsePreviousValue: true }));
    parameters.push({
      ParameterKey: "ProjectEnabled",
      ParameterValue: String(enabled),
    });
    const name = `project-${enabled ? "enable" : "disable"}-${Date.now()}`;
    aws([
      "cloudformation",
      "create-change-set",
      "--stack-name",
      STACK,
      "--change-set-name",
      name,
      "--template-body",
      template,
      "--parameters",
      JSON.stringify(parameters),
      "--capabilities",
      "CAPABILITY_IAM",
    ]);
    let set,
      executed = false;
    await waitFor(() => {
      set = aws([
        "cloudformation",
        "describe-change-set",
        "--stack-name",
        STACK,
        "--change-set-name",
        name,
      ]);
      return ["CREATE_COMPLETE", "FAILED"].includes(set.Status);
    }, "Change-set creation");
    try {
      if (set.Status === "FAILED") throw new Error(set.StatusReason);
      assertSafeChanges(set.Changes || []);
      console.log(
        JSON.stringify({
          changeSet: name,
          changes: (set.Changes || []).map((c) => ({
            resource: c.ResourceChange.LogicalResourceId,
            replacement: c.ResourceChange.Replacement,
          })),
          preview,
        }),
      );
      if (preview) return;
      aws([
        "cloudformation",
        "execute-change-set",
        "--stack-name",
        STACK,
        "--change-set-name",
        name,
      ]);
      executed = true;
      await waitFor(() => {
        const next = stack();
        if (
          next.StackStatus.includes("ROLLBACK") ||
          next.StackStatus.includes("FAILED")
        )
          throw new Error(`CloudFormation: ${next.StackStatus}`);
        // Executed change sets can disappear. Verify the stack instead, without
        // mistaking the previous UPDATE_COMPLETE snapshot for completion.
        return (
          next.StackStatus === "UPDATE_COMPLETE" &&
          next.LastUpdatedTime !== current.LastUpdatedTime &&
          next.Parameters.find((p) => p.ParameterKey === "ProjectEnabled")
            ?.ParameterValue === String(enabled)
        );
      }, "CloudFormation update");
    } finally {
      if (!executed) {
        // A used change set may no longer be deletable; this never deletes a stack.
        try {
          aws([
            "cloudformation",
            "delete-change-set",
            "--stack-name",
            STACK,
            "--change-set-name",
            name,
          ]);
        } catch {}
      }
    }
  };
  const status = () => {
    const configured =
      stack().Parameters.find((p) => p.ParameterKey === "ProjectEnabled")
        ?.ParameterValue ?? "not-installed";
    const ingress = aws([
      "ec2",
      "describe-security-groups",
      "--group-ids",
      resources.SecurityGroup,
    ]).SecurityGroups[0].IpPermissions;
    const policies = aws([
      "iam",
      "list-role-policies",
      "--role-name",
      resources.Role,
    ]).PolicyNames;
    let denied = false;
    if (policies.includes("project-disabled")) {
      const p = aws([
        "iam",
        "get-role-policy",
        "--role-name",
        resources.Role,
        "--policy-name",
        "project-disabled",
      ]).PolicyDocument;
      const document =
        typeof p === "string" ? JSON.parse(decodeURIComponent(p)) : p;
      denied = document.Statement.some(
        (s) =>
          s.Effect === "Deny" &&
          s.Action === "*" &&
          s.Resource === "*" &&
          !s.Condition,
      );
    }
    const power = instance().State.Name;
    return {
      url: state.Url,
      instanceId: resources.Host,
      instanceState: power,
      projectEnabled: configured,
      publicIngressRules: ingress.length,
      awsAccessDenied: denied,
      disabled:
        configured === "false" &&
        power === "stopped" &&
        ingress.length === 0 &&
        denied,
    };
  };
  if (action === "status") return status();
  if (action === "plan-enable") {
    await update(true, true);
    return status();
  }
  if (action === "disable") {
    await stop(); // Stop compute even if a subsequent CF change is rejected.
    await update(false);
    await waitFor(() => instance().State.Name === "stopped", "EC2 shutdown");
    const result = status();
    if (!result.disabled)
      throw new Error(`Disable incomplete: ${JSON.stringify(result)}`);
    return result;
  }
  try {
    // Restore IAM/network while the server is still stopped, then boot.
    await update(true);
    await waitFor(
      () => instance().State.Name !== "stopping",
      "Previous shutdown",
    );
    const power = instance().State.Name;
    if (power === "stopped")
      aws(["ec2", "start-instances", "--instance-ids", resources.Host]);
    else if (!["running", "pending"].includes(power))
      throw new Error(`Cannot start from ${power}`);
    await waitFor(() => instance().State.Name === "running", "EC2 startup");
    await waitFor(
      async () => {
        try {
          const r = await fetch(new URL("/healthz", state.Url), {
            signal: AbortSignal.timeout(5000),
          });
          return r.ok && (await r.json()).ok === true;
        } catch {
          return false;
        }
      },
      "HTTPS application readiness",
      300000,
    );
    const result = status();
    if (result.projectEnabled !== "true" || result.awsAccessDenied)
      throw new Error("Enable verification failed");
    return result;
  } catch (error) {
    console.error(
      "Enable failed; returning the project to a stopped/disabled state.",
    );
    await stop();
    await update(false).catch((e) =>
      console.error(`Could not restore all guards: ${e.message}`),
    );
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const state = JSON.parse(readFileSync(".data/aws-deployment.json", "utf8"));
  const aws = (args) => {
    const output = execFileSync(
      "aws",
      [
        ...args,
        "--profile",
        process.env.AWS_PROFILE || state.profile,
        "--region",
        state.region,
        "--output",
        "json",
      ],
      { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
    );
    return output.trim() ? JSON.parse(output) : {};
  };
  console.log(
    JSON.stringify(
      await control(process.argv[2] || "status", state, aws),
      null,
      2,
    ),
  );
}
