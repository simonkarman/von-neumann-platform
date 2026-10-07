import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { awsMetricSchema } from "./aws-operations.js";
import { z } from "zod";
export async function awsMetric(
  q: z.infer<typeof awsMetricSchema>,
  options: any,
) {
  const namespace = {
    ec2: "AWS/EC2",
    rds: "AWS/RDS",
    lambda: "AWS/Lambda",
    dynamodb: "AWS/DynamoDB",
    ecs: "AWS/ECS",
    sqs: "AWS/SQS",
  }[q.service];
  const dimension = {
    ec2: "InstanceId",
    rds: "DBInstanceIdentifier",
    lambda: "FunctionName",
    dynamodb: "TableName",
    ecs: "ServiceName",
    sqs: "QueueName",
  }[q.service];
  const sum = [
    "Invocations",
    "Errors",
    "Throttles",
    "ConsumedReadCapacityUnits",
    "ConsumedWriteCapacityUnits",
    "ReadThrottleEvents",
    "WriteThrottleEvents",
    "NetworkIn",
    "NetworkOut",
    "DiskReadOps",
    "DiskWriteOps",
    "NumberOfMessagesSent",
  ].includes(q.metric);
  const statistic = sum ? "Sum" : "Average";
  const end = new Date(),
    start = new Date(end.getTime() - q.hours * 3600000);
  const client = new CloudWatchClient(options);
  try {
    const r = await client.send(
      new GetMetricDataCommand({
        StartTime: start,
        EndTime: end,
        ScanBy: "TimestampAscending",
        MaxDatapoints: 1500,
        MetricDataQueries: [
          {
            Id: "value",
            ReturnData: true,
            MetricStat: {
              Metric: {
                Namespace: namespace,
                MetricName: q.metric,
                Dimensions: [
                  { Name: dimension, Value: q.resourceId },
                  ...(q.cluster
                    ? [{ Name: "ClusterName", Value: q.cluster }]
                    : []),
                ],
              },
              Period: Math.max(
                300,
                Math.ceil((q.hours * 3600) / 1000 / 300) * 300,
              ),
              Stat: statistic,
            },
          },
        ],
      }),
      { abortSignal: AbortSignal.timeout(20000) },
    );
    const d = r.MetricDataResults?.[0];
    return {
      points: (d?.Timestamps || []).map((t, i) => ({
        time: t.toISOString(),
        value: d?.Values?.[i] ?? null,
      })),
      unit: /Utilization$/.test(q.metric)
        ? "%"
        : /Memory|StorageSpace|NetworkIn|NetworkOut/.test(q.metric)
          ? "bytes"
          : q.metric === "Duration"
            ? "ms"
            : q.metric.includes("Age")
              ? "seconds"
              : /IOPS$/.test(q.metric)
                ? "ops/s"
                : "count",
      statistic,
      metric: q.metric,
      partial: !!r.NextToken || d?.StatusCode === "PartialData",
      start: start.toISOString(),
      end: end.toISOString(),
    };
  } finally {
    client.destroy();
  }
}
