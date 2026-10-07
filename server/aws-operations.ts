import { z } from "zod";
// Explicit supported operations, not arbitrary SDK execution.
export const inventoryOperations = [
  "cloudformation_stacks",
  "cloudformation_resources",
  "rds_instances",
  "rds_clusters",
  "rds_snapshots",
  "rds_events",
  "lambda_functions",
  "lambda_event_sources",
  "ec2_instances",
  "ec2_volumes",
  "ec2_addresses",
  "ec2_images",
  "vpcs",
  "subnets",
  "security_groups",
  "route_tables",
  "nat_gateways",
  "internet_gateways",
  "network_acls",
  "vpc_endpoints",
  "network_interfaces",
  "vpc_peerings",
  "log_groups_inventory",
  "log_streams",
  "cloudtrail_events",
  "cloudtrail_trails",
  "dynamodb_tables",
  "dynamodb_details",
  "ecs_clusters",
  "ecs_services",
  "ecs_tasks",
  "eks_clusters",
  "eks_nodegroups",
  "s3_buckets",
  "iam_roles",
  "iam_users",
  "iam_policies",
  "load_balancers",
  "target_groups",
  "route53_zones",
  "route53_records",
  "cloudwatch_alarms",
  "sqs_queues",
  "sns_topics",
  "sns_subscriptions",
  "api_gateway_apis",
  "api_gateway_v2_apis",
  "step_functions",
  "step_function_executions",
  "ecr_repositories",
  "ecr_images",
  "elasticache_clusters",
  "cloudfront_distributions",
  "secrets_metadata",
  "kms_keys",
  "backup_vaults",
  "backup_jobs",
] as const;
export const globalOperations = new Set<string>([
  "s3_buckets",
  "iam_roles",
  "iam_users",
  "iam_policies",
  "route53_zones",
  "route53_records",
  "cloudfront_distributions",
]);
export const inventorySchema = z
  .object({
    operation: z.enum(inventoryOperations),
    region: z
      .string()
      .regex(/^(all|[a-z]{2}(?:-[a-z]+)+-\d)$/)
      .optional(),
    limit: z.number().int().min(1).max(10000).default(1000),
    resourceId: z.string().min(1).max(2048).optional(),
    cluster: z.string().min(1).max(2048).optional(),
    hours: z.number().int().min(1).max(2160).default(24),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.operation === "rds_events" && q.hours > 336)
      ctx.addIssue({
        code: "custom",
        message: "RDS events support at most 336 hours (14 days)",
      });
    const needsId = [
      "log_streams",
      "dynamodb_details",
      "eks_nodegroups",
      "route53_records",
      "step_function_executions",
      "ecr_images",
    ];
    if (needsId.includes(q.operation) && !q.resourceId)
      ctx.addIssue({
        code: "custom",
        message: `${q.operation} requires resourceId`,
      });
    if (["ecs_services", "ecs_tasks"].includes(q.operation) && !q.cluster)
      ctx.addIssue({
        code: "custom",
        message: `${q.operation} requires cluster`,
      });
    if (q.region === "all" && (q.resourceId || q.cluster))
      ctx.addIssue({
        code: "custom",
        message: "Resource-specific queries require one region",
      });
  });
export const metricNames = {
  ec2: [
    "CPUUtilization",
    "NetworkIn",
    "NetworkOut",
    "DiskReadOps",
    "DiskWriteOps",
    "StatusCheckFailed",
  ],
  rds: [
    "CPUUtilization",
    "DatabaseConnections",
    "FreeableMemory",
    "FreeStorageSpace",
    "ReadIOPS",
    "WriteIOPS",
  ],
  lambda: [
    "Invocations",
    "Errors",
    "Duration",
    "Throttles",
    "ConcurrentExecutions",
  ],
  dynamodb: [
    "ConsumedReadCapacityUnits",
    "ConsumedWriteCapacityUnits",
    "ReadThrottleEvents",
    "WriteThrottleEvents",
  ],
  ecs: ["CPUUtilization", "MemoryUtilization"],
  sqs: [
    "ApproximateNumberOfMessagesVisible",
    "ApproximateAgeOfOldestMessage",
    "NumberOfMessagesSent",
  ],
} as const;
export const awsMetricSchema = z
  .object({
    operation: z.literal("aws_metric"),
    region: z
      .string()
      .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
      .optional(),
    service: z.enum(["ec2", "rds", "lambda", "dynamodb", "ecs", "sqs"]),
    resourceId: z.string().min(1).max(1024),
    cluster: z.string().min(1).max(1024).optional(),
    metric: z.string().min(1),
    hours: z.number().int().min(1).max(168).default(24),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (!(metricNames[q.service] as readonly string[]).includes(q.metric))
      ctx.addIssue({
        code: "custom",
        message: `Unsupported ${q.service} metric`,
      });
    if (q.service === "ec2" && /[,\s]/.test(q.resourceId))
      ctx.addIssue({
        code: "custom",
        message:
          "Use one EC2 ID per query; use chart series for multiple resources",
      });
    if (q.service === "ecs" && !q.cluster)
      ctx.addIssue({
        code: "custom",
        message: "ECS metrics require cluster and service resourceId",
      });
    if (q.service !== "ecs" && q.cluster)
      ctx.addIssue({
        code: "custom",
        message: "cluster is only valid for ECS metrics",
      });
  });
export type InventoryQuery = z.infer<typeof inventorySchema>;
export function isInventoryQuery(q: {
  operation: string;
}): q is InventoryQuery {
  return (inventoryOperations as readonly string[]).includes(q.operation);
}
