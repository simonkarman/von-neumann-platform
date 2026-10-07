import { readFile } from "node:fs/promises";
import { AwsConnector } from "../server/connectors.js";
import { inventoryOperations } from "../server/aws-operations.js";
import { querySchema } from "../server/schema.js";
const discovery = JSON.parse(
  await readFile(".data/aws-inventory.json", "utf8"),
);
const region = process.env.AWS_REGION || discovery.regions[0];
const connector = new AwsConnector(
  "live",
  { instances: [], logGroups: [], tables: [] },
  { enabled: true, regions: discovery.regions, logReads: false },
);
const requiresAbsentResource = new Set([
  "dynamodb_details",
  "ecs_services",
  "ecs_tasks",
  "eks_nodegroups",
  "step_function_executions",
]);
const ecr = discovery.results.find(
  (r: any) => r.region === region && r.service === "ecr",
)?.items?.[0];
let failed = 0;
const queue = [...inventoryOperations];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (;;) {
      const operation = queue.shift();
      if (!operation) break;
      if (requiresAbsentResource.has(operation)) {
        console.log(`${operation}: SDK mocked; no matching live resource`);
        continue;
      }
      const resourceId =
        operation === "log_streams"
          ? process.env.CHECK_LOG_GROUP
          : operation === "route53_records"
            ? process.env.CHECK_HOSTED_ZONE_ID
            : operation === "ecr_images"
              ? typeof ecr === "string"
                ? ecr
                : ecr?.repositoryName
              : undefined;
      if (
        ["ecr_images", "log_streams", "route53_records"].includes(operation) &&
        !resourceId
      ) {
        console.log(`${operation}: no configured resource fixture`);
        continue;
      }
      try {
        const r = await connector.query(
          querySchema.parse({
            operation,
            region,
            limit: 20,
            hours: 1,
            resourceId,
          }),
        );
        console.log(
          `${operation}: rows=${r.items?.length ?? "?"} partial=${r.truncated || false} errors=${JSON.stringify(r.errors || [])}`,
        );
        if (r.errors?.length) failed++;
      } catch (e: any) {
        failed++;
        console.log(`${operation}: FAILED ${e.message}`);
      }
    }
  }),
);
const all = await connector.query(
  querySchema.parse({
    operation: "cloudformation_resources",
    region: "all",
    limit: 10000,
  }),
);
console.log(
  `All-region CloudFormation: resources=${all.items.length}, stacks=${Object.keys(all.countsByStack || {}).length}, partial=${all.truncated}, errors=${JSON.stringify(all.errors || [])}`,
);
if (all.errors?.length) failed++;
if (process.env.CHECK_INSTANCE_ID) {
  const metric = await connector.query(
    querySchema.parse({
      operation: "aws_metric",
      service: "ec2",
      resourceId: process.env.CHECK_INSTANCE_ID,
      region,
      metric: "CPUUtilization",
      hours: 1,
    }),
  );
  console.log(`EC2 metric: ${metric.points.length} points`);
}
if (failed) process.exitCode = 1;
