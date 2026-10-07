import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";

// Connector credentials are deliberately not installed into AWS_* environment
// variables: Secrets Manager and Bedrock retain the host's own IAM identity.
export let connectorCredentials:
  | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | undefined;
export let vertexCredentials:
  { client_email: string; private_key: string } | undefined;
export const connectorSecretSchema = z
  .object({
    auth: z.enum(["iam", "assume_role", "access_keys"]),
    region: z.string().min(1),
    instances: z.array(z.string()).default([]),
    logGroups: z.array(z.string()).default([]),
    tables: z.array(z.string()).default([]),
    inventoryEnabled: z.boolean().default(false),
    regions: z
      .array(z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/))
      .max(40)
      .default([]),
    allowLogReads: z.boolean().default(false),
    allowTableReads: z.boolean().default(false),
    roleArn: z.string().optional(),
    externalId: z.string().optional(),
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    sessionToken: z.string().optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.auth === "assume_role" && !s.roleArn)
      ctx.addIssue({ code: "custom", message: "roleArn required" });
    if (s.auth === "access_keys" && (!s.accessKeyId || !s.secretAccessKey))
      ctx.addIssue({ code: "custom", message: "access key pair required" });
  });
export async function loadSecrets() {
  const names = [
    "ADMIN_PASSWORD_SECRET_ARN",
    "SESSION_SECRET_ARN",
    "AWS_CONNECTOR_SECRET_ARN",
    "AI_CONFIG_SECRET_ARN",
  ];
  if (!names.some((n) => process.env[n])) return;
  const client = new SecretsManagerClient({
    region: process.env.SECRETS_REGION || process.env.AWS_REGION,
  });
  async function read(name: string) {
    try {
      const response = await client.send(
        new GetSecretValueCommand({ SecretId: process.env[name] }),
        { abortSignal: AbortSignal.timeout(15000) },
      );
      if (!response.SecretString) throw new Error("Empty secret");
      return response.SecretString;
    } catch {
      throw new Error(
        `Unable to load ${name}; check the secret ARN and instance-role permissions.`,
      );
    }
  }
  try {
    if (process.env.ADMIN_PASSWORD_SECRET_ARN)
      process.env.ADMIN_PASSWORD = await read("ADMIN_PASSWORD_SECRET_ARN");
    if (process.env.SESSION_SECRET_ARN)
      process.env.SESSION_SECRET = await read("SESSION_SECRET_ARN");
    if (process.env.AWS_CONNECTOR_SECRET_ARN) {
      const s = connectorSecretSchema.parse(
        JSON.parse(await read("AWS_CONNECTOR_SECRET_ARN")),
      );
      process.env.AWS_MODE = "live";
      process.env.AWS_REGION = s.region;
      process.env.AWS_INSTANCE_IDS = s.instances.join(",");
      process.env.AWS_LOG_GROUPS = s.logGroups.join(",");
      process.env.AWS_TABLES = s.tables.join(",");
      process.env.AWS_INVENTORY_ENABLED = String(s.inventoryEnabled);
      process.env.AWS_REGIONS = s.regions.join(",");
      process.env.AWS_ALLOW_LOG_READS = String(s.allowLogReads);
      process.env.AWS_ALLOW_TABLE_READS = String(s.allowTableReads);
      process.env.AWS_ROLE_ARN = s.auth === "assume_role" ? s.roleArn : "";
      process.env.AWS_EXTERNAL_ID = s.externalId || "";
      if (s.auth === "access_keys")
        connectorCredentials = {
          accessKeyId: s.accessKeyId!,
          secretAccessKey: s.secretAccessKey!,
          ...(s.sessionToken ? { sessionToken: s.sessionToken } : {}),
        };
    }
    if (process.env.AI_CONFIG_SECRET_ARN) {
      const s = z
        .discriminatedUnion("provider", [
          z
            .object({
              provider: z.literal("bedrock"),
              region: z.string().min(1),
              model: z.string().min(1),
            })
            .strict(),
          z
            .object({
              provider: z.literal("vertex"),
              project: z.string().min(1),
              location: z.string().default("global"),
              model: z.string().min(1),
              credentials: z
                .object({
                  client_email: z.string().email(),
                  private_key: z.string().min(1),
                })
                .optional(),
            })
            .strict(),
        ])
        .parse(JSON.parse(await read("AI_CONFIG_SECRET_ARN")));
      process.env.AI_PROVIDER = s.provider;
      if (s.provider === "bedrock") {
        process.env.BEDROCK_REGION = s.region;
        process.env.BEDROCK_MODEL = s.model;
      } else {
        process.env.GOOGLE_CLOUD_PROJECT = s.project;
        process.env.GOOGLE_CLOUD_LOCATION = s.location;
        process.env.VERTEX_MODEL = s.model;
        vertexCredentials = s.credentials;
      }
    }
  } finally {
    client.destroy();
  }
}
