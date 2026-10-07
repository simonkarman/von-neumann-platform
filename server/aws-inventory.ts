import type { InventoryQuery } from "./aws-operations.js";

type Row = Record<string, unknown>;
export type InventoryResult = {
  items: Row[];
  truncated: boolean;
  errors?: { scope: string; error: string }[];
  scannedStacks?: number;
  countsByStack?: Record<string, number>;
};
type PageConfig = {
  inputToken?: string;
  outputToken?: string;
  maxPages?: number;
  delay?: number;
};
export type Sender = (
  sdk: any,
  clientName: string,
  command: string,
  input: Record<string, unknown>,
) => Promise<any>;
export async function collectPages(
  fetchPage: (input: Record<string, unknown>) => Promise<any>,
  input: Record<string, unknown>,
  field: string,
  project: (row: any) => Row,
  limit: number,
  config: PageConfig = {},
): Promise<InventoryResult> {
  const items: Row[] = [];
  let token: any;
  const seen = new Set<string>();
  let truncated = false;
  for (let page = 0; page < (config.maxPages || 100); page++) {
    if (config.delay && page)
      await new Promise((r) => setTimeout(r, config.delay));
    const response = await fetchPage({
      ...input,
      ...(token ? { [config.inputToken || "NextToken"]: token } : {}),
    });
    const rows = field.split(".").reduce((o, k) => o?.[k], response) || [];
    if (!Array.isArray(rows))
      throw new Error("AWS inventory response has an unexpected shape");
    const room = limit - items.length;
    items.push(...rows.slice(0, room).map(project));
    token =
      config.outputToken?.split(".").reduce((o, k) => o?.[k], response) ??
      (!config.outputToken ? response.NextToken : undefined);
    truncated = !!token || rows.length > room;
    if (rows.length > room || (token && items.length >= limit)) {
      break;
    }
    if (!token) break;
    const key = JSON.stringify(token);
    if (seen.has(key)) {
      truncated = true;
      break;
    }
    seen.add(key);
    truncated = true;
  }
  return { items, truncated };
}
const date = (v: any) => (v instanceof Date ? v.toISOString() : v || "");
const name = (v: any) =>
  v.Tags?.find((t: any) => t.Key === "Name")?.Value || "";
export async function inventory(
  q: InventoryQuery,
  options: any,
  injected?: Sender,
): Promise<InventoryResult> {
  const clients = new Map<string, any>();
  const deadline = AbortSignal.timeout(90000);
  const send: Sender =
    injected ||
    (async (sdk, clientName, command, input) => {
      let client = clients.get(clientName);
      if (!client) {
        client = new sdk[clientName](options);
        clients.set(clientName, client);
      }
      return client.send(new sdk[command](input), { abortSignal: deadline });
    });
  const list = (
    sdk: any,
    client: string,
    command: string,
    input: Row,
    field: string,
    map: (r: any) => Row,
    pc: PageConfig = {},
  ) =>
    collectPages(
      (i) => send(sdk, client, command, i),
      input,
      field,
      map,
      q.limit,
      pc,
    );
  try {
    switch (q.operation) {
      case "cloudformation_stacks":
      case "cloudformation_resources": {
        const s = await import("@aws-sdk/client-cloudformation");
        const stacks = await collectPages(
          async (input) => {
            const r = await send(
              s,
              "CloudFormationClient",
              "ListStacksCommand",
              input,
            );
            return {
              ...r,
              StackSummaries: (r.StackSummaries || []).filter(
                (v: any) => v.StackStatus !== "DELETE_COMPLETE",
              ),
            };
          },
          {},
          "StackSummaries",
          (r) => ({
            stack: r.StackName,
            stackId: r.StackId,
            status: r.StackStatus,
            parentId: r.ParentId || "",
            rootId: r.RootId || "",
            updated: date(r.LastUpdatedTime || r.CreationTime),
          }),
          q.resourceId ? 10000 : q.limit,
        );
        if (q.operation === "cloudformation_stacks") return stacks;
        const result: InventoryResult = {
          items: [],
          truncated: stacks.truncated,
          errors: [],
          scannedStacks: 0,
          countsByStack: {},
        };
        for (const stack of stacks.items.filter(
          (r) =>
            !q.resourceId ||
            r.stackId === q.resourceId ||
            r.stack === q.resourceId,
        )) {
          if (result.items.length >= q.limit) {
            result.truncated = true;
            break;
          }
          try {
            const resources = await collectPages(
              (i) =>
                send(s, "CloudFormationClient", "ListStackResourcesCommand", i),
              { StackName: stack.stackId },
              "StackResourceSummaries",
              (r) => ({
                stack: stack.stack,
                stackId: stack.stackId,
                parentStackId: stack.parentId,
                logicalId: r.LogicalResourceId,
                physicalId: r.PhysicalResourceId || "",
                type: r.ResourceType,
                status: r.ResourceStatus,
                updated: date(r.LastUpdatedTimestamp),
              }),
              q.limit - result.items.length,
            );
            result.items.push(...resources.items);
            result.truncated ||= resources.truncated;
            result.scannedStacks!++;
            result.countsByStack![String(stack.stack)] = resources.items.length;
          } catch (e: any) {
            result.truncated = true;
            result.errors!.push({
              scope: String(stack.stack),
              error: e.name || "AWS query failed",
            });
          }
        }
        return result;
      }
      case "rds_instances":
      case "rds_clusters":
      case "rds_snapshots":
      case "rds_events": {
        const s = await import("@aws-sdk/client-rds"),
          c = "RDSClient",
          p = { inputToken: "Marker", outputToken: "Marker" };
        if (q.operation === "rds_instances")
          return list(
            s,
            c,
            "DescribeDBInstancesCommand",
            { MaxRecords: 100 },
            "DBInstances",
            (r) => ({
              name: r.DBInstanceIdentifier,
              engine: r.Engine,
              version: r.EngineVersion,
              status: r.DBInstanceStatus,
              class: r.DBInstanceClass,
              storageGiB: r.AllocatedStorage,
              encrypted: r.StorageEncrypted,
              multiAZ: r.MultiAZ,
              public: r.PubliclyAccessible,
              endpoint: r.Endpoint?.Address,
              port: r.Endpoint?.Port,
              vpc: r.DBSubnetGroup?.VpcId,
              arn: r.DBInstanceArn,
            }),
            p,
          );
        if (q.operation === "rds_clusters")
          return list(
            s,
            c,
            "DescribeDBClustersCommand",
            { MaxRecords: 100 },
            "DBClusters",
            (r) => ({
              name: r.DBClusterIdentifier,
              engine: r.Engine,
              version: r.EngineVersion,
              status: r.Status,
              members: r.DBClusterMembers?.length,
              encrypted: r.StorageEncrypted,
              endpoint: r.Endpoint,
              arn: r.DBClusterArn,
            }),
            p,
          );
        if (q.operation === "rds_snapshots")
          return list(
            s,
            c,
            "DescribeDBSnapshotsCommand",
            { MaxRecords: 100, SnapshotType: "manual" },
            "DBSnapshots",
            (r) => ({
              name: r.DBSnapshotIdentifier,
              database: r.DBInstanceIdentifier,
              status: r.Status,
              engine: r.Engine,
              created: date(r.SnapshotCreateTime),
              encrypted: r.Encrypted,
            }),
            p,
          );
        return list(
          s,
          c,
          "DescribeEventsCommand",
          { Duration: Math.min(q.hours * 60, 20160), MaxRecords: 100 },
          "Events",
          (r) => ({
            time: date(r.Date),
            source: r.SourceIdentifier,
            type: r.SourceType,
            message: r.Message,
          }),
          p,
        );
      }
      case "lambda_functions":
      case "lambda_event_sources": {
        const s = await import("@aws-sdk/client-lambda");
        if (q.operation === "lambda_functions")
          return list(
            s,
            "LambdaClient",
            "ListFunctionsCommand",
            { MaxItems: 50 },
            "Functions",
            (r) => ({
              name: r.FunctionName,
              arn: r.FunctionArn,
              runtime: r.Runtime || r.PackageType,
              memoryMB: r.MemorySize,
              timeoutSeconds: r.Timeout,
              modified: r.LastModified,
              codeBytes: r.CodeSize,
              architecture: r.Architectures?.join(","),
              vpc: r.VpcConfig?.VpcId || "",
            }),
            { inputToken: "Marker", outputToken: "NextMarker" },
          );
        return list(
          s,
          "LambdaClient",
          "ListEventSourceMappingsCommand",
          {
            MaxItems: 100,
            ...(q.resourceId ? { FunctionName: q.resourceId } : {}),
          },
          "EventSourceMappings",
          (r) => ({
            id: r.UUID,
            functionArn: r.FunctionArn,
            sourceArn: r.EventSourceArn,
            state: r.State,
            batchSize: r.BatchSize,
          }),
          { inputToken: "Marker", outputToken: "NextMarker" },
        );
      }
      case "ec2_instances":
      case "ec2_volumes":
      case "ec2_addresses":
      case "ec2_images":
      case "vpcs":
      case "subnets":
      case "security_groups":
      case "route_tables":
      case "nat_gateways":
      case "internet_gateways":
      case "network_acls":
      case "vpc_endpoints":
      case "network_interfaces":
      case "vpc_peerings": {
        const s = await import("@aws-sdk/client-ec2"),
          c = "EC2Client";
        switch (q.operation) {
          case "ec2_instances": {
            const r = await list(
              s,
              c,
              "DescribeInstancesCommand",
              { MaxResults: 100 },
              "Reservations",
              (r) => ({ instances: r.Instances }),
            );
            const items = r.items.flatMap((r) =>
              ((r.instances as any[]) || []).map((i) => ({
                id: i.InstanceId,
                name: name(i),
                state: i.State?.Name,
                type: i.InstanceType,
                zone: i.Placement?.AvailabilityZone,
                vpc: i.VpcId,
                subnet: i.SubnetId,
                privateIp: i.PrivateIpAddress,
                publicIp: i.PublicIpAddress || "",
                launched: date(i.LaunchTime),
              })),
            );
            return {
              items: items.slice(0, q.limit),
              truncated: r.truncated || items.length > q.limit,
            };
          }
          case "ec2_volumes":
            return list(
              s,
              c,
              "DescribeVolumesCommand",
              { MaxResults: 100 },
              "Volumes",
              (r) => ({
                id: r.VolumeId,
                name: name(r),
                sizeGiB: r.Size,
                type: r.VolumeType,
                state: r.State,
                encrypted: r.Encrypted,
                zone: r.AvailabilityZone,
                attachedTo: r.Attachments?.map((a: any) => a.InstanceId).join(
                  ",",
                ),
              }),
            );
          case "ec2_addresses":
            return list(
              s,
              c,
              "DescribeAddressesCommand",
              {},
              "Addresses",
              (r) => ({
                id: r.AllocationId,
                name: name(r),
                publicIp: r.PublicIp,
                privateIp: r.PrivateIpAddress,
                instance: r.InstanceId || "",
                association: r.AssociationId || "",
              }),
            );
          case "ec2_images":
            return list(
              s,
              c,
              "DescribeImagesCommand",
              { Owners: ["self"], MaxResults: 100 },
              "Images",
              (r) => ({
                id: r.ImageId,
                name: r.Name,
                state: r.State,
                architecture: r.Architecture,
                created: r.CreationDate,
              }),
            );
          case "vpcs":
            return list(
              s,
              c,
              "DescribeVpcsCommand",
              { MaxResults: 100 },
              "Vpcs",
              (r) => ({
                id: r.VpcId,
                name: name(r),
                cidr: r.CidrBlock,
                state: r.State,
                default: r.IsDefault,
              }),
            );
          case "subnets":
            return list(
              s,
              c,
              "DescribeSubnetsCommand",
              { MaxResults: 100 },
              "Subnets",
              (r) => ({
                id: r.SubnetId,
                name: name(r),
                vpc: r.VpcId,
                cidr: r.CidrBlock,
                zone: r.AvailabilityZone,
                availableIps: r.AvailableIpAddressCount,
                publicIpOnLaunch: r.MapPublicIpOnLaunch,
              }),
            );
          case "security_groups":
            return list(
              s,
              c,
              "DescribeSecurityGroupsCommand",
              { MaxResults: 100 },
              "SecurityGroups",
              (r) => ({
                id: r.GroupId,
                name: r.GroupName,
                vpc: r.VpcId,
                inbound: r.IpPermissions,
                outbound: r.IpPermissionsEgress,
              }),
            );
          case "route_tables":
            return list(
              s,
              c,
              "DescribeRouteTablesCommand",
              { MaxResults: 100 },
              "RouteTables",
              (r) => ({
                id: r.RouteTableId,
                name: name(r),
                vpc: r.VpcId,
                routes: r.Routes,
                associations: r.Associations?.map((a: any) => ({
                  subnet: a.SubnetId,
                  main: a.Main,
                })),
              }),
            );
          case "nat_gateways":
            return list(
              s,
              c,
              "DescribeNatGatewaysCommand",
              { MaxResults: 100 },
              "NatGateways",
              (r) => ({
                id: r.NatGatewayId,
                name: name(r),
                vpc: r.VpcId,
                subnet: r.SubnetId,
                state: r.State,
                type: r.ConnectivityType,
              }),
            );
          case "internet_gateways":
            return list(
              s,
              c,
              "DescribeInternetGatewaysCommand",
              { MaxResults: 100 },
              "InternetGateways",
              (r) => ({
                id: r.InternetGatewayId,
                name: name(r),
                vpcs: r.Attachments?.map((a: any) => a.VpcId).join(","),
              }),
            );
          case "network_acls":
            return list(
              s,
              c,
              "DescribeNetworkAclsCommand",
              { MaxResults: 100 },
              "NetworkAcls",
              (r) => ({
                id: r.NetworkAclId,
                name: name(r),
                vpc: r.VpcId,
                default: r.IsDefault,
                entries: r.Entries,
              }),
            );
          case "vpc_endpoints":
            return list(
              s,
              c,
              "DescribeVpcEndpointsCommand",
              { MaxResults: 100 },
              "VpcEndpoints",
              (r) => ({
                id: r.VpcEndpointId,
                vpc: r.VpcId,
                service: r.ServiceName,
                type: r.VpcEndpointType,
                state: r.State,
              }),
            );
          case "network_interfaces":
            return list(
              s,
              c,
              "DescribeNetworkInterfacesCommand",
              { MaxResults: 100 },
              "NetworkInterfaces",
              (r) => ({
                id: r.NetworkInterfaceId,
                vpc: r.VpcId,
                subnet: r.SubnetId,
                privateIp: r.PrivateIpAddress,
                type: r.InterfaceType,
                status: r.Status,
                instance: r.Attachment?.InstanceId || "",
              }),
            );
          default:
            return list(
              s,
              c,
              "DescribeVpcPeeringConnectionsCommand",
              { MaxResults: 100 },
              "VpcPeeringConnections",
              (r) => ({
                id: r.VpcPeeringConnectionId,
                status: r.Status?.Code,
                requester: r.RequesterVpcInfo?.VpcId,
                accepter: r.AccepterVpcInfo?.VpcId,
              }),
            );
        }
      }
      case "log_groups_inventory":
      case "log_streams": {
        const s = await import("@aws-sdk/client-cloudwatch-logs");
        if (q.operation === "log_groups_inventory")
          return list(
            s,
            "CloudWatchLogsClient",
            "DescribeLogGroupsCommand",
            { limit: 50 },
            "logGroups",
            (r) => ({
              name: r.logGroupName,
              arn: r.arn,
              retentionDays: r.retentionInDays || "never expire",
              storedBytes: r.storedBytes,
              class: r.logGroupClass,
              created: new Date(r.creationTime).toISOString(),
            }),
            { inputToken: "nextToken", outputToken: "nextToken" },
          );
        return list(
          s,
          "CloudWatchLogsClient",
          "DescribeLogStreamsCommand",
          {
            logGroupName: q.resourceId,
            orderBy: "LastEventTime",
            descending: true,
            limit: 50,
          },
          "logStreams",
          (r) => ({
            name: r.logStreamName,
            lastEvent: r.lastEventTimestamp
              ? new Date(r.lastEventTimestamp).toISOString()
              : "",
            firstEvent: r.firstEventTimestamp
              ? new Date(r.firstEventTimestamp).toISOString()
              : "",
          }),
          { inputToken: "nextToken", outputToken: "nextToken" },
        );
      }
      case "cloudtrail_events":
      case "cloudtrail_trails": {
        const s = await import("@aws-sdk/client-cloudtrail");
        if (q.operation === "cloudtrail_trails")
          return list(
            s,
            "CloudTrailClient",
            "ListTrailsCommand",
            {},
            "Trails",
            (r) => ({
              name: r.Name,
              arn: r.TrailARN,
              homeRegion: r.HomeRegion,
            }),
          );
        return list(
          s,
          "CloudTrailClient",
          "LookupEventsCommand",
          {
            StartTime: new Date(Date.now() - q.hours * 3600000),
            EndTime: new Date(),
            MaxResults: 50,
          },
          "Events",
          (r) => ({
            id: r.EventId,
            time: date(r.EventTime),
            event: r.EventName,
            source: r.EventSource,
            user: r.Username,
            readOnly: r.ReadOnly,
            resources: r.Resources?.map((x: any) => ({
              type: x.ResourceType,
              name: x.ResourceName,
            })),
          }),
          { delay: 550, maxPages: 20 },
        );
      }
      case "dynamodb_tables":
      case "dynamodb_details": {
        const s = await import("@aws-sdk/client-dynamodb");
        if (q.operation === "dynamodb_tables")
          return list(
            s,
            "DynamoDBClient",
            "ListTablesCommand",
            { Limit: 100 },
            "TableNames",
            (r) => ({ name: r }),
            {
              inputToken: "ExclusiveStartTableName",
              outputToken: "LastEvaluatedTableName",
            },
          );
        const r = (
          await send(s, "DynamoDBClient", "DescribeTableCommand", {
            TableName: q.resourceId,
          })
        ).Table;
        return {
          items: [
            {
              name: r.TableName,
              arn: r.TableArn,
              status: r.TableStatus,
              estimatedItemCount: r.ItemCount,
              sizeBytes: r.TableSizeBytes,
              billing: r.BillingModeSummary?.BillingMode || "PROVISIONED",
              keys: r.KeySchema,
              indexes: r.GlobalSecondaryIndexes?.map((i: any) => ({
                name: i.IndexName,
                status: i.IndexStatus,
              })),
              countNote:
                "AWS estimate updated periodically, not a live row count",
            },
          ],
          truncated: false,
        };
      }
      case "ecs_clusters":
      case "ecs_services":
      case "ecs_tasks": {
        const s = await import("@aws-sdk/client-ecs");
        const field =
          q.operation === "ecs_clusters"
            ? "clusterArns"
            : q.operation === "ecs_services"
              ? "serviceArns"
              : "taskArns";
        const cmd =
          q.operation === "ecs_clusters"
            ? "ListClustersCommand"
            : q.operation === "ecs_services"
              ? "ListServicesCommand"
              : "ListTasksCommand";
        const r = await list(
          s,
          "ECSClient",
          cmd,
          { maxResults: 100, ...(q.cluster ? { cluster: q.cluster } : {}) },
          field,
          (v) => ({ arn: v }),
          { inputToken: "nextToken", outputToken: "nextToken" },
        );
        if (!r.items.length) return r;
        const items: Row[] = [];
        const batch = q.operation === "ecs_services" ? 10 : 100;
        for (let i = 0; i < r.items.length; i += batch) {
          const ids = r.items.slice(i, i + batch).map((v) => v.arn);
          const command =
            q.operation === "ecs_clusters"
              ? "DescribeClustersCommand"
              : q.operation === "ecs_services"
                ? "DescribeServicesCommand"
                : "DescribeTasksCommand";
          const key =
            q.operation === "ecs_clusters"
              ? "clusters"
              : q.operation === "ecs_services"
                ? "services"
                : "tasks";
          const response = await send(s, "ECSClient", command, {
            [key]: ids,
            ...(q.cluster ? { cluster: q.cluster } : {}),
          });
          for (const v of response[key] || [])
            items.push(
              q.operation === "ecs_clusters"
                ? {
                    name: v.clusterName,
                    arn: v.clusterArn,
                    status: v.status,
                    services: v.activeServicesCount,
                    runningTasks: v.runningTasksCount,
                    pendingTasks: v.pendingTasksCount,
                  }
                : q.operation === "ecs_services"
                  ? {
                      name: v.serviceName,
                      arn: v.serviceArn,
                      status: v.status,
                      desired: v.desiredCount,
                      running: v.runningCount,
                      pending: v.pendingCount,
                      launchType: v.launchType,
                      taskDefinition: v.taskDefinition,
                    }
                  : {
                      arn: v.taskArn,
                      status: v.lastStatus,
                      desiredStatus: v.desiredStatus,
                      launchType: v.launchType,
                      taskDefinition: v.taskDefinitionArn,
                      started: date(v.startedAt),
                    },
            );
          if (response.failures?.length) r.truncated = true;
        }
        return { ...r, items };
      }
      case "eks_clusters":
      case "eks_nodegroups": {
        const s = await import("@aws-sdk/client-eks");
        if (q.operation === "eks_nodegroups")
          return list(
            s,
            "EKSClient",
            "ListNodegroupsCommand",
            { clusterName: q.resourceId, maxResults: 100 },
            "nodegroups",
            (r) => ({ cluster: q.resourceId, name: r }),
            { inputToken: "nextToken", outputToken: "nextToken" },
          );
        const r = await list(
          s,
          "EKSClient",
          "ListClustersCommand",
          { maxResults: 100 },
          "clusters",
          (v) => ({ name: v }),
          { inputToken: "nextToken", outputToken: "nextToken" },
        );
        const items = [];
        for (const v of r.items) {
          const c = (
            await send(s, "EKSClient", "DescribeClusterCommand", {
              name: v.name,
            })
          ).cluster;
          items.push({
            name: c.name,
            arn: c.arn,
            status: c.status,
            version: c.version,
            platform: c.platformVersion,
            vpc: c.resourcesVpcConfig?.vpcId,
            publicEndpoint: c.resourcesVpcConfig?.endpointPublicAccess,
            created: date(c.createdAt),
          });
        }
        return { ...r, items };
      }
      case "s3_buckets": {
        const s = await import("@aws-sdk/client-s3");
        return list(
          s,
          "S3Client",
          "ListBucketsCommand",
          { MaxBuckets: 1000 },
          "Buckets",
          (r) => ({
            name: r.Name,
            created: date(r.CreationDate),
            bucketRegion: r.BucketRegion || "not returned",
          }),
          { inputToken: "ContinuationToken", outputToken: "ContinuationToken" },
        );
      }
      case "iam_roles":
      case "iam_users":
      case "iam_policies": {
        const s = await import("@aws-sdk/client-iam");
        const p = { inputToken: "Marker", outputToken: "Marker" };
        if (q.operation === "iam_roles")
          return list(
            s,
            "IAMClient",
            "ListRolesCommand",
            { MaxItems: 100 },
            "Roles",
            (r) => ({
              name: r.RoleName,
              arn: r.Arn,
              path: r.Path,
              created: date(r.CreateDate),
            }),
            p,
          );
        if (q.operation === "iam_users")
          return list(
            s,
            "IAMClient",
            "ListUsersCommand",
            { MaxItems: 100 },
            "Users",
            (r) => ({
              name: r.UserName,
              arn: r.Arn,
              path: r.Path,
              created: date(r.CreateDate),
              passwordLastUsed: date(r.PasswordLastUsed),
            }),
            p,
          );
        return list(
          s,
          "IAMClient",
          "ListPoliciesCommand",
          { MaxItems: 100, Scope: "Local" },
          "Policies",
          (r) => ({
            name: r.PolicyName,
            arn: r.Arn,
            attached: r.AttachmentCount,
            updated: date(r.UpdateDate),
          }),
          p,
        );
      }
      case "load_balancers":
      case "target_groups": {
        const s = await import("@aws-sdk/client-elastic-load-balancing-v2");
        const p = { inputToken: "Marker", outputToken: "NextMarker" };
        if (q.operation === "load_balancers")
          return list(
            s,
            "ElasticLoadBalancingV2Client",
            "DescribeLoadBalancersCommand",
            { PageSize: 100 },
            "LoadBalancers",
            (r) => ({
              name: r.LoadBalancerName,
              arn: r.LoadBalancerArn,
              type: r.Type,
              scheme: r.Scheme,
              state: r.State?.Code,
              dns: r.DNSName,
              vpc: r.VpcId,
            }),
            p,
          );
        return list(
          s,
          "ElasticLoadBalancingV2Client",
          "DescribeTargetGroupsCommand",
          { PageSize: 100 },
          "TargetGroups",
          (r) => ({
            name: r.TargetGroupName,
            arn: r.TargetGroupArn,
            protocol: r.Protocol,
            port: r.Port,
            vpc: r.VpcId,
            targetType: r.TargetType,
          }),
          p,
        );
      }
      case "route53_zones":
      case "route53_records": {
        const s = await import("@aws-sdk/client-route-53");
        if (q.operation === "route53_zones")
          return list(
            s,
            "Route53Client",
            "ListHostedZonesCommand",
            { MaxItems: 100 },
            "HostedZones",
            (r) => ({
              name: r.Name,
              id: r.Id,
              private: r.Config?.PrivateZone,
              records: r.ResourceRecordSetCount,
            }),
            { inputToken: "Marker", outputToken: "NextMarker" },
          );
        const items: Row[] = [];
        let start: Row = {};
        let truncated = false;
        for (let i = 0; i < 100; i++) {
          const r = await send(
            s,
            "Route53Client",
            "ListResourceRecordSetsCommand",
            { HostedZoneId: q.resourceId, MaxItems: 100, ...start },
          );
          const rows = (r.ResourceRecordSets || []).map((v: any) => ({
            name: v.Name,
            type: v.Type,
            ttl: v.TTL,
            values:
              v.ResourceRecords?.map((x: any) => x.Value).join(", ") ||
              v.AliasTarget?.DNSName ||
              "",
            identifier: v.SetIdentifier || "",
          }));
          const room = q.limit - items.length;
          items.push(...rows.slice(0, room));
          truncated = !!r.IsTruncated || rows.length > room;
          if (!r.IsTruncated || items.length >= q.limit) break;
          start = {
            StartRecordName: r.NextRecordName,
            StartRecordType: r.NextRecordType,
            ...(r.NextRecordIdentifier
              ? { StartRecordIdentifier: r.NextRecordIdentifier }
              : {}),
          };
        }
        return { items, truncated };
      }
      case "cloudwatch_alarms": {
        const s = await import("@aws-sdk/client-cloudwatch");
        return collectPages(
          async (input) => {
            const r = await send(
              s,
              "CloudWatchClient",
              "DescribeAlarmsCommand",
              input,
            );
            return {
              ...r,
              alarms: [...(r.MetricAlarms || []), ...(r.CompositeAlarms || [])],
            };
          },
          { MaxRecords: 100, AlarmTypes: ["MetricAlarm", "CompositeAlarm"] },
          "alarms",
          (r) => ({
            name: r.AlarmName,
            state: r.StateValue,
            kind: r.AlarmRule ? "composite" : "metric",
            namespace: r.Namespace || "",
            metric: r.MetricName || "",
            threshold: r.Threshold,
            updated: date(r.StateUpdatedTimestamp),
          }),
          q.limit,
        );
      }
      case "sqs_queues": {
        const s = await import("@aws-sdk/client-sqs");
        return list(
          s,
          "SQSClient",
          "ListQueuesCommand",
          { MaxResults: 1000 },
          "QueueUrls",
          (r) => ({ name: r.split("/").pop(), url: r }),
        );
      }
      case "sns_topics":
      case "sns_subscriptions": {
        const s = await import("@aws-sdk/client-sns");
        return q.operation === "sns_topics"
          ? list(s, "SNSClient", "ListTopicsCommand", {}, "Topics", (r) => ({
              arn: r.TopicArn,
              name: r.TopicArn?.split(":").pop(),
            }))
          : list(
              s,
              "SNSClient",
              "ListSubscriptionsCommand",
              {},
              "Subscriptions",
              (r) => ({
                arn: r.SubscriptionArn,
                topic: r.TopicArn,
                protocol: r.Protocol,
                owner: r.Owner,
              }),
            );
      }
      case "api_gateway_apis": {
        const s = await import("@aws-sdk/client-api-gateway");
        return list(
          s,
          "APIGatewayClient",
          "GetRestApisCommand",
          { limit: 100 },
          "items",
          (r) => ({
            id: r.id,
            name: r.name,
            created: date(r.createdDate),
            endpointTypes: r.endpointConfiguration?.types?.join(","),
          }),
          { inputToken: "position", outputToken: "position" },
        );
      }
      case "api_gateway_v2_apis": {
        const s = await import("@aws-sdk/client-apigatewayv2");
        return list(
          s,
          "ApiGatewayV2Client",
          "GetApisCommand",
          { MaxResults: "100" },
          "Items",
          (r) => ({
            id: r.ApiId,
            name: r.Name,
            protocol: r.ProtocolType,
            endpoint: r.ApiEndpoint,
          }),
        );
      }
      case "step_functions":
      case "step_function_executions": {
        const s = await import("@aws-sdk/client-sfn");
        const p = { inputToken: "nextToken", outputToken: "nextToken" };
        return q.operation === "step_functions"
          ? list(
              s,
              "SFNClient",
              "ListStateMachinesCommand",
              { maxResults: 100 },
              "stateMachines",
              (r) => ({
                name: r.name,
                arn: r.stateMachineArn,
                type: r.type,
                created: date(r.creationDate),
              }),
              p,
            )
          : list(
              s,
              "SFNClient",
              "ListExecutionsCommand",
              { stateMachineArn: q.resourceId, maxResults: 100 },
              "executions",
              (r) => ({
                name: r.name,
                arn: r.executionArn,
                status: r.status,
                start: date(r.startDate),
                stop: date(r.stopDate),
              }),
              p,
            );
      }
      case "ecr_repositories":
      case "ecr_images": {
        const s = await import("@aws-sdk/client-ecr");
        const p = { inputToken: "nextToken", outputToken: "nextToken" };
        return q.operation === "ecr_repositories"
          ? list(
              s,
              "ECRClient",
              "DescribeRepositoriesCommand",
              { maxResults: 100 },
              "repositories",
              (r) => ({
                name: r.repositoryName,
                arn: r.repositoryArn,
                uri: r.repositoryUri,
                scanOnPush: r.imageScanningConfiguration?.scanOnPush,
                created: date(r.createdAt),
              }),
              p,
            )
          : list(
              s,
              "ECRClient",
              "DescribeImagesCommand",
              { repositoryName: q.resourceId, maxResults: 100 },
              "imageDetails",
              (r) => ({
                digest: r.imageDigest,
                tags: r.imageTags?.join(",") || "",
                sizeBytes: r.imageSizeInBytes,
                pushed: date(r.imagePushedAt),
              }),
              p,
            );
      }
      case "elasticache_clusters": {
        const s = await import("@aws-sdk/client-elasticache");
        return list(
          s,
          "ElastiCacheClient",
          "DescribeCacheClustersCommand",
          { MaxRecords: 100 },
          "CacheClusters",
          (r) => ({
            name: r.CacheClusterId,
            status: r.CacheClusterStatus,
            engine: r.Engine,
            version: r.EngineVersion,
            nodeType: r.CacheNodeType,
            nodes: r.NumCacheNodes,
            zone: r.PreferredAvailabilityZone,
          }),
          { inputToken: "Marker", outputToken: "Marker" },
        );
      }
      case "cloudfront_distributions": {
        const s = await import("@aws-sdk/client-cloudfront");
        return list(
          s,
          "CloudFrontClient",
          "ListDistributionsCommand",
          { MaxItems: 100 },
          "DistributionList.Items",
          (r) => ({
            id: r.Id,
            arn: r.ARN,
            domain: r.DomainName,
            status: r.Status,
            enabled: r.Enabled,
            aliases: r.Aliases?.Items?.join(",") || "",
          }),
          { inputToken: "Marker", outputToken: "DistributionList.NextMarker" },
        );
      }
      case "secrets_metadata": {
        const s = await import("@aws-sdk/client-secrets-manager");
        return list(
          s,
          "SecretsManagerClient",
          "ListSecretsCommand",
          { MaxResults: 100 },
          "SecretList",
          (r) => ({
            name: r.Name,
            arn: r.ARN,
            rotationEnabled: r.RotationEnabled || false,
            lastChanged: date(r.LastChangedDate),
            lastAccessed: date(r.LastAccessedDate),
          }),
        );
      }
      case "kms_keys": {
        const s = await import("@aws-sdk/client-kms");
        return list(
          s,
          "KMSClient",
          "ListKeysCommand",
          { Limit: 100 },
          "Keys",
          (r) => ({ id: r.KeyId, arn: r.KeyArn }),
          { inputToken: "Marker", outputToken: "NextMarker" },
        );
      }
      case "backup_vaults":
      case "backup_jobs": {
        const s = await import("@aws-sdk/client-backup");
        return q.operation === "backup_vaults"
          ? list(
              s,
              "BackupClient",
              "ListBackupVaultsCommand",
              { MaxResults: 100 },
              "BackupVaultList",
              (r) => ({
                name: r.BackupVaultName,
                arn: r.BackupVaultArn,
                recoveryPoints: r.NumberOfRecoveryPoints,
                created: date(r.CreationDate),
              }),
            )
          : list(
              s,
              "BackupClient",
              "ListBackupJobsCommand",
              {
                MaxResults: 100,
                ByCreatedAfter: new Date(Date.now() - q.hours * 3600000),
              },
              "BackupJobs",
              (r) => ({
                id: r.BackupJobId,
                resource: r.ResourceArn,
                type: r.ResourceType,
                state: r.State,
                vault: r.BackupVaultName,
                created: date(r.CreationDate),
                completed: date(r.CompletionDate),
              }),
            );
      }
      default:
        throw new Error("Unsupported AWS operation");
    }
  } finally {
    for (const c of clients.values()) c.destroy();
  }
}
