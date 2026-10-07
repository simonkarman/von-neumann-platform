import test from "node:test";
import assert from "node:assert/strict";
import {
  inventoryOperations,
  inventorySchema,
} from "../server/aws-operations.js";
import { inventory, collectPages } from "../server/aws-inventory.js";
import { querySchema, dashboardSchema } from "../server/schema.js";
import { AwsConnector } from "../server/connectors.js";
import { withinWidgetScope } from "../server/share-scope.js";
import { validateRequestedCharts } from "../server/dashboard-intent.js";
test("every hardcoded operation maps to existing SDK client/command exports", async () => {
  for (const operation of inventoryOperations) {
    let calls = 0;
    await inventory(
      inventorySchema.parse({
        operation,
        resourceId: "example",
        cluster: "example",
      }),
      {},
      async (s, client, command) => {
        calls++;
        assert.equal(typeof s[client], "function", `${operation}: ${client}`);
        assert.equal(typeof s[command], "function", `${operation}: ${command}`);
        return {
          Table: { TableName: "example" },
          DistributionList: { Items: [] },
        };
      },
    );
    assert.ok(calls > 0, operation);
  }
});
test("EC2 queries resolve discovered regions and reject model-invented regions", async () => {
  const c = new AwsConnector(
    "live",
    { instances: [], logGroups: [], tables: [] },
    { enabled: true, regions: ["eu-west-1", "us-east-1"], logReads: true },
  );
  c.query = async (q) => {
    assert.equal(q.operation, "ec2_instances");
    return { items: [{ id: "i-00000000000000002", region: "eu-west-1" }] };
  };
  const q = querySchema.parse({
    operation: "cpu",
    instanceId: "i-00000000000000002",
    hours: 24,
  });
  assert.equal((await c.prepareQuery(q)).region, "eu-west-1");
  await assert.rejects(
    c.prepareQuery({ ...q, region: "us-east-1" }),
    /is in eu-west-1, not us-east-1/,
  );
});
test("explicit EC2 graph requests cannot silently save only a scalar metric card", () => {
  const prompt =
    "Also add a CPU usage graph for instance i-00000000000000002 for the last 24 hours. Keep the CloudFormation resources table.";
  const spec = dashboardSchema.parse({
    title: "Test",
    widgets: [
      {
        id: "cpu",
        title: "CPU",
        type: "metric",
        query: { operation: "cpu", instanceId: "i-00000000000000002" },
      },
    ],
  });
  assert.throws(() => validateRequestedCharts(prompt, spec), /type to 'chart'/);
  assert.doesNotThrow(() =>
    validateRequestedCharts("Add a CPU metric card", spec),
  );
  spec.widgets[0].type = "chart";
  assert.doesNotThrow(() => validateRequestedCharts(prompt, spec));
});
test("pagination follows cursors, reports caps even without a next token, and stops repeated cursors", async () => {
  let calls = 0;
  const result = await collectPages(
    async (input) => {
      calls++;
      return input.NextToken
        ? { items: [3] }
        : { items: [1, 2], NextToken: "next" };
    },
    {},
    "items",
    (n) => ({ n }),
    10,
  );
  assert.equal(result.items.length, 3);
  assert.equal(calls, 2);
  assert.equal(result.truncated, false);
  const capped = await collectPages(
    async () => ({ items: [1, 2, 3] }),
    {},
    "items",
    (n) => ({ n }),
    2,
  );
  assert.equal(capped.items.length, 2);
  assert.equal(capped.truncated, true);
  calls = 0;
  const repeated = await collectPages(
    async () => {
      calls++;
      return { items: [], NextToken: "same" };
    },
    {},
    "items",
    (n) => ({ n }),
    10,
  );
  assert.equal(calls, 2);
  assert.equal(repeated.truncated, true);
});
test("CloudFormation includes nested stack records once and excludes deleted stacks", async () => {
  const result = await inventory(
    inventorySchema.parse({ operation: "cloudformation_resources" }),
    {},
    async (_s, _c, cmd, input) =>
      cmd === "ListStacksCommand"
        ? {
            StackSummaries: [
              {
                StackId: "root",
                StackName: "root",
                StackStatus: "CREATE_COMPLETE",
              },
              {
                StackId: "child",
                StackName: "child",
                ParentId: "root",
                StackStatus: "CREATE_COMPLETE",
              },
              {
                StackId: "deleted",
                StackName: "deleted",
                StackStatus: "DELETE_COMPLETE",
              },
            ],
          }
        : {
            StackResourceSummaries:
              input.StackName === "root"
                ? [
                    {
                      LogicalResourceId: "Nested",
                      ResourceType: "AWS::CloudFormation::Stack",
                      PhysicalResourceId: "child",
                    },
                  ]
                : [
                    {
                      LogicalResourceId: "Bucket",
                      ResourceType: "AWS::S3::Bucket",
                      PhysicalResourceId: "bucket",
                    },
                  ],
          },
  );
  assert.equal(result.items.length, 2);
  assert.equal(result.scannedStacks, 2);
  assert.deepEqual(result.countsByStack, { root: 1, child: 1 });
});
test("sensitive Lambda configuration and raw CloudTrail bodies are never exposed", async () => {
  const lambda = await inventory(
    inventorySchema.parse({ operation: "lambda_functions" }),
    {},
    async () => ({
      Functions: [
        {
          FunctionName: "f",
          Environment: { Variables: { SECRET: "do-not-return" } },
          Code: { Location: "secret-url" },
        },
      ],
    }),
  );
  assert.ok(!JSON.stringify(lambda).includes("do-not-return"));
  assert.ok(!JSON.stringify(lambda).includes("secret-url"));
  const events = await inventory(
    inventorySchema.parse({ operation: "cloudtrail_events" }),
    {},
    async () => ({
      Events: [
        {
          EventName: "Update",
          CloudTrailEvent: "sensitive-request-body",
          AccessKeyId: "sensitive-key",
        },
      ],
    }),
  );
  assert.ok(!JSON.stringify(events).includes("sensitive"));
});
test("inventory is opt-in and validates regions before AWS calls", async () => {
  const c = new AwsConnector(
    "live",
    { instances: [], logGroups: [], tables: [] },
    { enabled: false, regions: ["eu-west-1"], logReads: false },
  );
  await assert.rejects(
    c.query(querySchema.parse({ operation: "rds_instances" })),
    /not enabled/,
  );
  await assert.rejects(
    c.query(
      querySchema.parse({ operation: "rds_instances", region: "us-east-1" }),
    ),
    /Region/,
  );
  assert.equal(
    querySchema.safeParse({ operation: "invoke_lambda", resourceId: "f" })
      .success,
    false,
  );
  assert.equal(
    querySchema.safeParse({
      operation: "aws_metric",
      service: "lambda",
      resourceId: "f",
      metric: "unapproved",
      hours: 1,
    }).success,
    false,
  );
  assert.equal(
    querySchema.safeParse({ operation: "ecs_services" }).success,
    false,
  );
  assert.equal(
    querySchema.safeParse({ operation: "logs", logGroup: "x", hours: 5000 })
      .success,
    false,
  );
});
test("viewer cannot widen inventory region, resource, time or row limits", () => {
  const a = querySchema.parse({
    operation: "cloudformation_resources",
    region: "eu-west-1",
    resourceId: "allowed",
    limit: 100,
  });
  for (const change of [
    { region: "us-east-1" },
    { resourceId: "different" },
    { resourceId: undefined },
    { limit: 101 },
  ])
    assert.equal(
      withinWidgetScope(a, querySchema.parse({ ...a, ...change }), "eu-west-1"),
      false,
    );
  assert.equal(
    withinWidgetScope(a, querySchema.parse({ ...a, limit: 10 }), "eu-west-1"),
    true,
  );
  const audit = querySchema.parse({ operation: "cloudtrail_events", hours: 1 });
  assert.equal(
    withinWidgetScope(
      audit,
      querySchema.parse({ ...audit, hours: 2 }),
      "eu-west-1",
    ),
    false,
  );
});
test("account-wide access accepts arbitrary instance IDs and opted-in logs/tables, but still rejects writes", () => {
  const c = new AwsConnector(
    "live",
    { instances: [], logGroups: [], tables: [] },
    { enabled: true, regions: ["eu-west-1"], logReads: true, tableReads: true },
  );
  for (const raw of [
    { operation: "cpu", instanceId: "i-00000000000000002", hours: 24 },
    { operation: "logs", logGroup: "/aws/lambda/any-function" },
    { operation: "table", table: "any-table" },
  ])
    assert.doesNotThrow(() => c.validate(querySchema.parse(raw)));
  assert.equal(
    querySchema.safeParse({ operation: "delete_table", table: "any-table" })
      .success,
    false,
  );
  assert.equal(
    querySchema.safeParse({ operation: "rds_events", hours: 337 }).success,
    false,
  );
});
test("generic tables/count cards accept CloudFormation inventory, charts require time series", () => {
  const w = {
    id: "inventory",
    type: "table",
    title: "Stacks",
    groupBy: "stack",
    query: {
      operation: "cloudformation_resources",
      region: "all",
      limit: 10000,
    },
  };
  assert.ok(
    dashboardSchema.safeParse({ title: "Inventory", widgets: [w] }).success,
  );
  assert.ok(
    dashboardSchema.safeParse({
      title: "Inventory",
      widgets: [{ ...w, type: "metric" }],
    }).success,
  );
  assert.equal(
    dashboardSchema.safeParse({
      title: "Inventory",
      widgets: [{ ...w, type: "chart" }],
    }).success,
    false,
  );
});
