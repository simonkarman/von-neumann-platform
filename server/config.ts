import "dotenv/config";
import path from "node:path";
import { z } from "zod";
import { loadSecrets } from "./secrets.js";

await loadSecrets();

const env = z
  .object({
    NODE_ENV: z.string().default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default("127.0.0.1"),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(1).default(0),
    PUBLIC_URL: z.url().default("http://localhost:3000"),
    DATA_DIR: z.string().default(".data"),
    DASHBOARD_TEMPLATE_DIR: z.string().default("dashboard-base"),
    DASHBOARD_REPO_URL: z.string().default(""),
    AI_PROVIDER: z
      .enum(["demo", "vertex", "bedrock", "openai", "copilot"])
      .default("vertex"),
    GOOGLE_CLOUD_PROJECT: z.string().default(""),
    GOOGLE_CLOUD_LOCATION: z.string().default("global"),
    VERTEX_MODEL: z.string().default("gemini-2.5-flash"),
    BEDROCK_REGION: z.string().default("eu-west-1"),
    BEDROCK_MODEL: z.string().default("eu.anthropic.claude-sonnet-5-5"),
    OPENAI_MODEL: z.string().default("gpt-5.4"),
    COPILOT_MODEL: z.string().default("gpt-5.4"),
    AWS_MODE: z.enum(["demo", "live"]).default("demo"),
    AWS_REGION: z.string().default("eu-west-1"),
    AWS_ROLE_ARN: z.string().default(""),
    AWS_EXTERNAL_ID: z.string().default(""),
    ADMIN_PASSWORD: z.string().default(""),
    SESSION_SECRET: z.string().default(""),
    RUNTIME_DRIVER: z.enum(["process", "docker"]).default("process"),
    MAX_ACTIVE_SESSIONS: z.coerce.number().int().min(1).max(32).default(4),
    MAX_SESSIONS: z.coerce.number().int().min(1).max(10000).default(100),
    MAX_DAILY_PROMPTS: z.coerce.number().int().min(1).max(10000).default(100),
    SESSION_IDLE_MINUTES: z.coerce.number().min(1).default(30),
    SESSION_START_TIMEOUT_MS: z.coerce.number().min(1000).default(120000),
    SESSION_IMAGE: z.string().default("von-neumann-session:local"),
    SESSION_DOCKER_NETWORK: z.string().default("von-neumann-sessions"),
    SESSION_HOST_ROOT: z.string().default(""),
    SESSION_VOLUME: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
      .or(z.literal(""))
      .default("von-neumann-data"),
  })
  .parse(process.env);
if (
  env.NODE_ENV === "production" &&
  (env.ADMIN_PASSWORD.length < 20 || env.SESSION_SECRET.length < 32)
) {
  throw new Error(
    "Production requires ADMIN_PASSWORD (20+ characters) and SESSION_SECRET (32+ characters).",
  );
}
if (
  !env.ADMIN_PASSWORD &&
  !["localhost", "127.0.0.1", "::1"].includes(env.HOST)
) {
  throw new Error("A non-loopback listener requires ADMIN_PASSWORD.");
}
if (
  env.RUNTIME_DRIVER === "docker" &&
  !env.SESSION_VOLUME &&
  !path.isAbsolute(env.SESSION_HOST_ROOT)
) {
  throw new Error(
    "Docker runtime requires an absolute SESSION_HOST_ROOT shared with the host.",
  );
}
export const config = {
  ...env,
  DATA_DIR: path.resolve(env.DATA_DIR),
  DASHBOARD_TEMPLATE_DIR: path.resolve(env.DASHBOARD_TEMPLATE_DIR),
};
export const listEnv = (name: string) =>
  (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
