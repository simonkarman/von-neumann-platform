import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { assertProjectEnabled } from "./project-guard.mjs";
import { deploymentConfig, expectedAccount } from "./deployment-config.mjs";
const config = deploymentConfig();
const { profile, region } = config;
if (existsSync(".data/aws-deployment.json")) {
  const previous = JSON.parse(
    readFileSync(".data/aws-deployment.json", "utf8"),
  );
  if (
    expectedAccount(previous) !== config.account ||
    previous.region !== region ||
    (previous.ApplicationStack || "von-neumann-application") !==
      config.applicationStack ||
    new URL(previous.Url).hostname !== config.domain
  )
    throw new Error(
      "This checkout already belongs to another deployment/domain. Use a separate checkout; existing state was preserved.",
    );
}
function aws(args, inherit = false) {
  const output = execFileSync(
    "aws",
    [
      ...args,
      "--profile",
      profile,
      "--region",
      region,
      "--output",
      "json",
      "--no-cli-pager",
    ],
    {
      encoding: "utf8",
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return inherit ? undefined : JSON.parse(output);
}
const identity = aws(["sts", "get-caller-identity"]);
if (identity.Account !== config.account)
  throw new Error("Refusing deployment into a different account.");
assertProjectEnabled({
  profile,
  region,
  ApplicationStack: config.applicationStack,
  allowMissing: true,
});
// Resolve exact invoke resources in this account/region; no cross-account IDs or model wildcards.
const modelInfo = /^(us|eu|apac|global)\./.test(config.model)
  ? aws([
      "bedrock",
      "get-inference-profile",
      "--inference-profile-identifier",
      config.model,
    ])
  : aws([
      "bedrock",
      "get-foundation-model",
      "--model-identifier",
      config.model,
    ]);
const modelResources = modelInfo.inferenceProfileArn
  ? [modelInfo.inferenceProfileArn, ...modelInfo.models.map((m) => m.modelArn)]
  : [modelInfo.modelDetails.modelArn];
aws(
  [
    "cloudformation",
    "deploy",
    "--stack-name",
    config.foundationStack,
    "--template-file",
    "deploy/cloudformation/foundation.yaml",
    "--no-fail-on-empty-changeset",
    "--parameter-overrides",
    `Domain=${config.domain}`,
    `ProjectName=${config.project}`,
    `BedrockModelId=${config.model}`,
    "--tags",
    "Application=von-neumann",
    "ManagedBy=CloudFormation",
  ],
  true,
);
const outputs = (name) =>
  Object.fromEntries(
    aws([
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      name,
    ]).Stacks[0].Outputs.map((o) => [o.OutputKey, o.OutputValue]),
  );
const foundation = outputs(config.foundationStack);
// Save foundation outputs even if application creation later fails (DNS and recovery).
mkdirSync(".data", { recursive: true });
writeFileSync(
  ".data/aws-foundation.json",
  JSON.stringify({ ...config, ...foundation }, null, 2),
  { mode: 0o600 },
);
mkdirSync(".data/releases", { recursive: true });
const archive = ".data/releases/source.tar.gz";
execFileSync(
  "tar",
  [
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
  ],
  { stdio: "inherit" },
);
const hash = createHash("sha256")
  .update(readFileSync(archive))
  .digest("hex")
  .slice(0, 20);
const key = `releases/${hash}.tar.gz`;
aws(
  [
    "s3",
    "cp",
    archive,
    `s3://${foundation.ArtifactBucket}/${key}`,
    "--only-show-errors",
  ],
  true,
);
const names = [
  "HostedZoneId",
  "ArtifactBucket",
  "AdminPasswordArn",
  "SessionSecretArn",
  "ConnectorSecretArn",
  "AiSecretArn",
];
aws(
  [
    "cloudformation",
    "deploy",
    "--stack-name",
    config.applicationStack,
    "--template-file",
    "deploy/cloudformation/application.yaml",
    "--capabilities",
    "CAPABILITY_IAM",
    "--no-fail-on-empty-changeset",
    "--parameter-overrides",
    `Domain=${config.domain}`,
    `ProjectName=${config.project}`,
    `InventoryRegions=${config.regions.join(",")}`,
    `BedrockInvokeResources=${modelResources.join(",")}`,
    ...names.map((n) => `${n}=${foundation[n]}`),
    `ArtifactKey=${key}`,
    "--tags",
    "Application=von-neumann",
    "ManagedBy=CloudFormation",
  ],
  true,
);
const application = outputs(config.applicationStack);
const state = {
  AccountId: identity.Account,
  Domain: config.domain,
  ProjectName: config.project,
  FoundationStack: config.foundationStack,
  ApplicationStack: config.applicationStack,
  profile,
  region,
  ...foundation,
  ...application,
  ArtifactKey: key,
};
// Preserve recovery/control metadata even if the following secret update fails.
writeFileSync(
  ".data/aws-deployment.json",
  JSON.stringify(state, null, 2) + "\n",
  { mode: 0o600 },
);
// Preserve operator-added connector resources on redeploy, adding only this host.
const connector = JSON.parse(
  aws([
    "secretsmanager",
    "get-secret-value",
    "--secret-id",
    foundation.ConnectorSecretArn,
  ]).SecretString,
);
connector.instances = [
  ...new Set([...(connector.instances || []), application.InstanceId]),
];
connector.logGroups = [
  ...new Set([...(connector.logGroups || []), application.LogGroup]),
];
// This payload is IAM configuration, not a static credential. Refuse to put
// actual credentials on a command line if an operator changed the secret.
if (
  connector.auth !== "iam" ||
  connector.accessKeyId ||
  connector.secretAccessKey
)
  throw new Error(
    "Connector customized; update its resource allowlists manually.",
  );
aws([
  "secretsmanager",
  "put-secret-value",
  "--secret-id",
  foundation.ConnectorSecretArn,
  "--secret-string",
  JSON.stringify(connector),
]);
console.log(
  JSON.stringify(
    {
      url: state.Url,
      instance: state.InstanceId,
      nameservers: state.NameServers,
      artifact: key,
    },
    null,
    2,
  ),
);
console.log(
  "Infrastructure deployed. Wait for cloud-init and verify /var/lib/von-neumann-ready through SSM; public TLS also requires parent-zone delegation.",
);
