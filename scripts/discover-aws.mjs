import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
const exec = promisify(execFile);
const profile =
  process.env.DEPLOY_PROFILE || process.env.AWS_PROFILE || "default";
const region =
  process.env.DEPLOY_REGION || process.env.AWS_REGION || "eu-west-1";
async function aws(region, args) {
  return JSON.parse(
    (
      await exec(
        "aws",
        [...args, "--profile", profile, "--region", region, "--output", "json"],
        { timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
      )
    ).stdout,
  );
}
const identity = await aws(region, ["sts", "get-caller-identity"]);
if (
  process.env.DEPLOY_ACCOUNT_ID &&
  identity.Account !== process.env.DEPLOY_ACCOUNT_ID
)
  throw new Error("Wrong account");
const regions = await aws(region, [
  "ec2",
  "describe-regions",
  "--query",
  "Regions[].RegionName",
]);
const probes = [
  [
    "ec2",
    "describe-instances",
    "Reservations[].Instances[].{id:InstanceId,state:State.Name}",
  ],
  [
    "ec2",
    "describe-vpcs",
    "Vpcs[?IsDefault==`false`].{id:VpcId,cidr:CidrBlock}",
  ],
  [
    "lambda",
    "list-functions",
    "Functions[].{name:FunctionName,runtime:Runtime}",
  ],
  [
    "rds",
    "describe-db-instances",
    "DBInstances[].{name:DBInstanceIdentifier,engine:Engine}",
  ],
  [
    "rds",
    "describe-db-clusters",
    "DBClusters[].{name:DBClusterIdentifier,engine:Engine}",
  ],
  ["dynamodb", "list-tables", "TableNames"],
  ["ecs", "list-clusters", "clusterArns"],
  ["eks", "list-clusters", "clusters"],
  [
    "cloudformation",
    "list-stacks",
    "StackSummaries[?StackStatus!=`DELETE_COMPLETE`].{name:StackName,status:StackStatus}",
  ],
  [
    "logs",
    "describe-log-groups",
    "logGroups[].{name:logGroupName,bytes:storedBytes}",
  ],
  [
    "elbv2",
    "describe-load-balancers",
    "LoadBalancers[].{name:LoadBalancerName,type:Type}",
  ],
  ["ecr", "describe-repositories", "repositories[].repositoryName"],
  ["sqs", "list-queues", "QueueUrls"],
  ["sns", "list-topics", "Topics[].TopicArn"],
  ["apigateway", "get-rest-apis", "items[].{id:id,name:name}"],
  ["apigatewayv2", "get-apis", "Items[].{id:ApiId,name:Name}"],
  ["stepfunctions", "list-state-machines", "stateMachines[].name"],
  [
    "elasticache",
    "describe-cache-clusters",
    "CacheClusters[].{name:CacheClusterId,engine:Engine}",
  ],
];
const tasks = regions.flatMap((region) =>
  probes.map((probe) => ({ region, probe })),
);
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (next < tasks.length) {
      const { region, probe } = tasks[next++];
      const [service, action, query] = probe;
      try {
        const items = await aws(region, [service, action, "--query", query]);
        results.push({
          region,
          service,
          action,
          count: items?.length || 0,
          items: items || [],
        });
        if (items?.length)
          console.log(`${region} ${service}/${action}: ${items.length}`);
      } catch (e) {
        results.push({
          region,
          service,
          action,
          error: String(e.stderr || e.message).slice(0, 400),
        });
        console.log(`${region} ${service}: unavailable`);
      }
    }
  }),
);
for (const [service, action, query] of [
  ["s3api", "list-buckets", "Buckets[].Name"],
  ["iam", "list-roles", "Roles[].RoleName"],
  ["iam", "list-users", "Users[].UserName"],
  ["route53", "list-hosted-zones", "HostedZones[].{id:Id,name:Name}"],
  [
    "cloudfront",
    "list-distributions",
    "DistributionList.Items[].{id:Id,domain:DomainName}",
  ],
]) {
  try {
    const items = await aws("us-east-1", [service, action, "--query", query]);
    results.push({
      region: "global",
      service,
      action,
      count: items?.length || 0,
      items: items || [],
    });
    console.log(`global ${service}/${action}: ${items?.length || 0}`);
  } catch (e) {
    results.push({
      region: "global",
      service,
      action,
      error: String(e.stderr || e.message).slice(0, 400),
    });
  }
}
mkdirSync(".data", { recursive: true });
writeFileSync(
  ".data/aws-inventory.json",
  JSON.stringify(
    {
      account: identity.Account,
      regions,
      fetchedAt: new Date().toISOString(),
      results,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log("Metadata-only discovery saved to .data/aws-inventory.json");
