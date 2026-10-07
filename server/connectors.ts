import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { config, listEnv } from "./config.js";
import { querySchema, type Query } from "./schema.js";
import { connectorCredentials } from "./secrets.js";
import {
  inventoryOperations,
  globalOperations,
  inventorySchema,
  metricNames,
  isInventoryQuery,
} from "./aws-operations.js";
import { inventory } from "./aws-inventory.js";
import { awsMetric } from "./aws-metrics.js";
const inventoryCache = new Map<
  string,
  { expires: number; value: Promise<any> }
>();

export interface Connector {
  id: string;
  describe(): unknown;
  validate(query: Query): void;
  prepareQuery?(query: Query): Promise<Query>;
  query(query: Query): Promise<any>;
}
const demoInstances = [
  {
    id: "i-demo-api",
    name: "production-api",
    state: "running",
    type: "t3.large",
  },
  {
    id: "i-demo-worker",
    name: "event-worker",
    state: "running",
    type: "t3.medium",
  },
];
export class AwsConnector implements Connector {
  id = "aws";
  constructor(
    private mode = config.AWS_MODE,
    private policy = {
      instances: listEnv("AWS_INSTANCE_IDS"),
      logGroups: listEnv("AWS_LOG_GROUPS"),
      tables: listEnv("AWS_TABLES"),
    },
    private settings: {
      enabled: boolean;
      regions: string[];
      logReads: boolean;
      tableReads?: boolean;
    } = {
      enabled: process.env.AWS_INVENTORY_ENABLED === "true",
      regions: listEnv("AWS_REGIONS").length
        ? listEnv("AWS_REGIONS")
        : [config.AWS_REGION],
      logReads: process.env.AWS_ALLOW_LOG_READS === "true",
      tableReads: process.env.AWS_ALLOW_TABLE_READS === "true",
    },
  ) {}
  describe() {
    return {
      id: this.id,
      name: "Amazon Web Services",
      mode: this.mode,
      region: config.AWS_REGION,
      capabilities: [
        "instances",
        "cpu",
        "log_groups",
        "logs",
        "table",
        ...(this.settings.enabled || this.mode === "demo"
          ? [...inventoryOperations, "aws_metric"]
          : []),
      ],
      regions: this.settings.regions,
      metricNames,
      access: {
        inventory: this.settings.enabled || this.mode === "demo",
        logContents: this.settings.logReads
          ? "all log groups in configured regions"
          : "explicit log-group allowlist",
        tableRecords: this.settings.tableReads
          ? "bounded read-only scans of all tables in configured regions"
          : "explicit table allowlist only; inventory does not grant record access",
        instances: this.settings.enabled
          ? "all instances in configured regions; no per-instance allowlist"
          : "explicit instance allowlist",
        excluded:
          "No SQL, function invocation, S3 object bodies, secret values, Lambda environment variables, or mutating AWS calls",
      },
      resources:
        this.mode === "demo"
          ? {
              instances: demoInstances.map((i) => i.id),
              logGroups: ["/von-neumann/api", "/von-neumann/worker"],
              tables: ["users"],
            }
          : this.policy,
    };
  }
  validate(q: Query) {
    const policy = this.describe().resources;
    const region = "region" in q ? q.region : undefined;
    if (region && region !== "all" && !this.settings.regions.includes(region))
      throw new Error("Region is not enabled for this connector.");
    if (
      (inventoryOperations as readonly string[]).includes(q.operation) ||
      q.operation === "aws_metric"
    ) {
      if (!this.settings.enabled && this.mode !== "demo")
        throw new Error(
          "AWS inventory operations are not enabled for this connector.",
        );
      return;
    }
    if (
      q.operation === "cpu" &&
      !this.settings.enabled &&
      !policy.instances.includes(q.instanceId)
    )
      throw new Error("Instance is not in the connector allowlist.");
    if (
      q.operation === "logs" &&
      !this.settings.logReads &&
      !policy.logGroups.includes(q.logGroup)
    )
      throw new Error("Log group is not in the connector allowlist.");
    if (
      q.operation === "table" &&
      !this.settings.tableReads &&
      !policy.tables.includes(q.table)
    )
      throw new Error("Table is not in the connector allowlist.");
  }
  async prepareQuery(raw: Query): Promise<Query> {
    const q = querySchema.parse(raw);
    this.validate(q);
    const instanceId =
      q.operation === "cpu"
        ? q.instanceId
        : q.operation === "aws_metric" && q.service === "ec2"
          ? q.resourceId
          : undefined;
    if (!instanceId || !this.settings.enabled || this.mode !== "live") return q;
    const discovered = await this.query(
      querySchema.parse({
        operation: "ec2_instances",
        region: "all",
        limit: 10000,
      }),
    );
    const matches = discovered.items.filter((r: any) => r.id === instanceId);
    if (
      q.region &&
      matches.length &&
      !matches.some((r: any) => r.region === q.region)
    )
      throw new Error(
        `Instance ${instanceId} is in ${matches.map((r: any) => r.region).join(", ")}, not ${q.region}. Use its discovered region.`,
      );
    if (!q.region && matches.length === 1)
      return { ...q, region: matches[0].region };
    if (!q.region && matches.length > 1)
      throw new Error(
        "Instance ID matches multiple regions; specify its region.",
      );
    return q;
  }
  async query(raw: Query): Promise<any> {
    const q = await this.prepareQuery(raw);
    this.validate(q);
    if (
      this.settings.enabled &&
      this.mode === "live" &&
      (q.operation === "instances" || q.operation === "log_groups")
    ) {
      const result = await this.query(
        querySchema.parse({
          operation:
            q.operation === "instances"
              ? "ec2_instances"
              : "log_groups_inventory",
          region:
            q.region ||
            (q.operation === "instances" ? "all" : config.AWS_REGION),
          limit: 10000,
        }),
      );
      return { ...result, operation: q.operation };
    }
    const fetchedAt = new Date().toISOString();
    const region =
      "region" in q && q.region && q.region !== "all"
        ? q.region
        : config.AWS_REGION;
    const options = {
      region,
      maxAttempts: 3,
      credentials: config.AWS_ROLE_ARN
        ? fromTemporaryCredentials({
            params: {
              RoleArn: config.AWS_ROLE_ARN,
              RoleSessionName: "von-neumann-read",
              ...(config.AWS_EXTERNAL_ID
                ? { ExternalId: config.AWS_EXTERNAL_ID }
                : {}),
            },
          })
        : connectorCredentials,
    };
    if (isInventoryQuery(q)) {
      const query = inventorySchema.parse(q);
      if (this.mode === "demo")
        return {
          items: [
            {
              region,
              stack: "demo-stack",
              name: "demo-resource",
              type: "AWS::EC2::Instance",
              status: "CREATE_COMPLETE",
            },
          ],
          count: 1,
          truncated: false,
          mode: "demo",
          fetchedAt,
          region,
        };
      const key = JSON.stringify({
        query,
        role: config.AWS_ROLE_ARN,
        regions: this.settings.regions,
      });
      const cached = inventoryCache.get(key);
      if (cached && cached.expires > Date.now()) return cached.value;
      const value = (async () => {
        const regions = globalOperations.has(query.operation)
          ? ["us-east-1"]
          : query.region === "all"
            ? this.settings.regions
            : [region];
        const items: any[] = [],
          errors: { scope: string; error: string }[] = [];
        let partial = false,
          next = 0;
        await Promise.all(
          Array.from({ length: Math.min(3, regions.length) }, async () => {
            while (next < regions.length) {
              const r = regions[next++];
              try {
                const result = await inventory(query, {
                  ...options,
                  region: r,
                });
                items.push(
                  ...result.items.map((item) => ({
                    region: globalOperations.has(query.operation)
                      ? "global"
                      : r,
                    ...item,
                  })),
                );
                partial ||= result.truncated;
                errors.push(
                  ...(result.errors || []).map((e) => ({
                    scope: `${r}/${e.scope}`,
                    error: e.error,
                  })),
                );
              } catch (e: any) {
                partial = true;
                errors.push({ scope: r, error: e.name || "AWS query failed" });
              }
            }
          }),
        );
        if (!items.length && errors.length)
          throw new Error(
            `Inventory could not complete: ${errors
              .map((e) => `${e.scope}: ${e.error}`)
              .slice(0, 5)
              .join("; ")}`,
          );
        const visible: any[] = [];
        let bytes = 0;
        for (const item of items.sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        )) {
          bytes += JSON.stringify(item).length;
          if (visible.length >= query.limit || bytes > 2000000) {
            partial = true;
            break;
          }
          visible.push(item);
        }
        const countsByStack: Record<string, number> = {};
        if (query.operation === "cloudformation_resources")
          for (const r of visible) {
            const k = `${r.region}/${r.stack}`;
            countsByStack[k] = (countsByStack[k] || 0) + 1;
          }
        return {
          items: visible,
          count: visible.length,
          countsByStack:
            query.operation === "cloudformation_resources"
              ? countsByStack
              : undefined,
          truncated: partial || items.length > query.limit,
          errors,
          mode: "live",
          fetchedAt,
          region: query.region || region,
          operation: query.operation,
          countNote:
            query.operation === "cloudformation_resources"
              ? "CloudFormation resource records, not a live drift audit. Nested stack resource records belong to their direct stack."
              : undefined,
        };
      })().catch((e) => {
        inventoryCache.delete(key);
        throw e;
      });
      if (inventoryCache.size >= 128)
        inventoryCache.delete(inventoryCache.keys().next().value!);
      inventoryCache.set(key, { expires: Date.now() + 300000, value });
      return value;
    }
    if (q.operation === "aws_metric") {
      if (this.mode === "demo")
        return {
          ...this.demo({
            operation: "cpu",
            instanceId: "i-demo-api",
            hours: q.hours,
          }),
          mode: "demo",
          fetchedAt,
          region,
        };
      return {
        ...(await awsMetric(q, options)),
        mode: "live",
        fetchedAt,
        region,
      };
    }
    if (this.mode === "demo")
      return {
        ...this.demo(q),
        mode: "demo",
        fetchedAt,
        region: config.AWS_REGION,
      };
    const requestOptions = { abortSignal: AbortSignal.timeout(20000) };
    let result: any;
    if (q.operation === "instances") {
      if (!this.policy.instances.length) result = { items: [] };
      else {
        const client = new EC2Client(options);
        try {
          const r = await client.send(
            new DescribeInstancesCommand({
              InstanceIds: this.policy.instances,
            }),
            requestOptions,
          );
          result = {
            items: (r.Reservations || [])
              .flatMap((r) => r.Instances || [])
              .map((i) => ({
                id: i.InstanceId,
                name:
                  i.Tags?.find((t) => t.Key === "Name")?.Value || i.InstanceId,
                state: i.State?.Name,
                type: i.InstanceType,
              })),
          };
        } finally {
          client.destroy();
        }
      }
    } else if (q.operation === "log_groups")
      result = { items: this.policy.logGroups.map((name) => ({ name })) };
    else if (q.operation === "cpu") {
      const client = new CloudWatchClient(options);
      const end = new Date(),
        start = new Date(end.getTime() - q.hours * 3600000);
      try {
        const r = await client.send(
          new GetMetricDataCommand({
            StartTime: start,
            EndTime: end,
            ScanBy: "TimestampAscending",
            MaxDatapoints: 1500,
            MetricDataQueries: [
              {
                Id: "cpu",
                ReturnData: true,
                MetricStat: {
                  Metric: {
                    Namespace: "AWS/EC2",
                    MetricName: "CPUUtilization",
                    Dimensions: [{ Name: "InstanceId", Value: q.instanceId }],
                  },
                  Period: Math.max(
                    300,
                    Math.ceil((q.hours * 3600) / 1000 / 300) * 300,
                  ),
                  Stat: "Average",
                },
              },
            ],
          }),
          requestOptions,
        );
        const data = r.MetricDataResults?.[0];
        result = {
          points: (data?.Timestamps || []).map((t, i) => ({
            time: t.toISOString(),
            value: data?.Values?.[i] ?? null,
          })),
          unit: "%",
          statistic: "Average",
          start: start.toISOString(),
          end: end.toISOString(),
          partial: !!r.NextToken || data?.StatusCode === "PartialData",
        };
      } finally {
        client.destroy();
      }
    } else if (q.operation === "logs") {
      const client = new CloudWatchLogsClient(options),
        items: any[] = [];
      let nextToken: string | undefined,
        pages = 0;
      try {
        do {
          const r = await client.send(
            new FilterLogEventsCommand({
              logGroupName: q.logGroup,
              startTime: Date.now() - q.hours * 3600000,
              endTime: Date.now(),
              filterPattern: q.filter || undefined,
              limit: Math.min(1000, q.limit - items.length),
              nextToken,
            }),
            requestOptions,
          );
          items.push(
            ...(r.events || []).map((e) => ({
              timestamp: new Date(e.timestamp || 0).toISOString(),
              stream: e.logStreamName,
              message: e.message,
            })),
          );
          const previous = nextToken;
          nextToken = r.nextToken;
          pages++;
          if (previous && previous === nextToken) break;
        } while (nextToken && items.length < q.limit && pages < 10);
        result = {
          items: items.slice(0, q.limit),
          truncated: !!nextToken || items.length > q.limit,
          limit: q.limit,
        };
      } finally {
        client.destroy();
      }
    } else {
      const base = new DynamoDBClient(options),
        client = DynamoDBDocumentClient.from(base);
      const items: any[] = [];
      let key: Record<string, any> | undefined,
        evaluated = 0,
        pages = 0;
      try {
        do {
          const r = await client.send(
            new ScanCommand({
              TableName: q.table,
              Limit: q.limit - evaluated,
              ExclusiveStartKey: key,
              ...(q.status
                ? {
                    FilterExpression: "#s = :s",
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: { ":s": q.status },
                  }
                : {}),
            }),
            requestOptions,
          );
          items.push(...(r.Items || []));
          evaluated += r.ScannedCount || 0;
          key = r.LastEvaluatedKey;
          pages++;
        } while (key && evaluated < q.limit && pages < 10);
        result = {
          items,
          matchingCount: items.length,
          evaluated,
          truncated: !!key,
          countScope: key
            ? "bounded sample, not a table-wide count"
            : "complete scan",
        };
      } finally {
        client.destroy();
      }
    }
    // Redaction is defense-in-depth. Resource allowlists and IAM remain the data boundary.
    return JSON.parse(
      redact(
        JSON.stringify({
          ...result,
          mode: "live",
          fetchedAt,
          region,
        }),
      ),
    );
  }
  private demo(
    q: Exclude<
      Query,
      import("./aws-operations.js").InventoryQuery | { operation: "aws_metric" }
    >,
  ): any {
    if (q.operation === "instances") return { items: demoInstances };
    if (q.operation === "log_groups")
      return {
        items: [{ name: "/von-neumann/api" }, { name: "/von-neumann/worker" }],
      };
    if (q.operation === "cpu") {
      const end = Math.floor(Date.now() / 300000) * 300000;
      return {
        unit: "%",
        statistic: "Average",
        partial: false,
        points: Array.from({ length: 96 }, (_, i) => ({
          time: new Date(
            end - ((95 - i) * q.hours * 3600000) / 96,
          ).toISOString(),
          value: +Math.max(
            5,
            Math.min(
              99,
              28 +
                Math.sin(i * 0.21) * 12 +
                Math.cos(i * 1.7) * 5 +
                (i > 48 && i < 59 ? 51 : 0) +
                (q.instanceId.includes("worker") ? 9 : 0),
            ),
          ).toFixed(1),
        })),
      };
    }
    if (q.operation === "logs")
      return {
        items: Array.from({ length: Math.min(40, q.limit) }, (_, i) => ({
          timestamp: new Date(Date.now() - i * 47000).toISOString(),
          stream: q.logGroup + "/application",
          message:
            i % 9 === 0
              ? "WARN request latency above threshold duration_ms=823"
              : `INFO request completed method=GET path=/api/health status=200 duration_ms=${18 + i}`,
        })).filter(
          (i) =>
            !q.filter ||
            i.message.toLowerCase().includes(q.filter.toLowerCase()),
        ),
        truncated: false,
      };
    const all = Array.from({ length: 48 }, (_, i) => ({
      id: `user-${String(i + 1).padStart(3, "0")}`,
      name: ["Alex Morgan", "Jordan Lee", "Sam Rivera", "Taylor Chen"][i % 4],
      status: i % 3 === 0 ? "signup" : "active",
      createdAt: new Date(Date.now() - i * 3600000).toISOString(),
    }));
    const sample = all.slice(0, q.limit);
    const items = sample.filter((i) => !q.status || i.status === q.status);
    return {
      items,
      matchingCount: items.length,
      evaluated: sample.length,
      truncated: q.limit < all.length,
      countScope:
        q.limit < all.length
          ? "bounded sample, not a table-wide count"
          : "complete scan",
    };
  }
}
export function redact(text: string) {
  return text
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_ACCESS_KEY]")
    .replace(
      /(password|secret|token|authorization)(["\\\s:=]+)([^\s,}"\\]{4,})/gi,
      "$1$2[REDACTED]",
    );
}
export const connectors = new Map<string, Connector>([
  ["aws", new AwsConnector()],
]);
export function getConnector(id: string) {
  const c = connectors.get(id);
  if (!c) throw new Error("Unknown connector");
  return c;
}
