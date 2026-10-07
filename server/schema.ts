import { z } from "zod";
import { inventorySchema, awsMetricSchema } from "./aws-operations.js";

export const sessionId = z.string().regex(/^[a-f0-9]{24}$/);
export const querySchema = z.discriminatedUnion("operation", [
  inventorySchema,
  awsMetricSchema,
  z
    .object({
      operation: z.literal("instances"),
      region: z
        .string()
        .regex(/^(all|[a-z]{2}(?:-[a-z]+)+-\d)$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("log_groups"),
      region: z
        .string()
        .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("cpu"),
      region: z
        .string()
        .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
        .optional(),
      instanceId: z
        .string()
        .min(1)
        .max(100)
        .regex(
          /^[^,\s]+$/,
          "Use one instance ID per query; use chart series for multiple instances",
        ),
      hours: z.number().int().min(1).max(168).default(24),
    })
    .strict(),
  z
    .object({
      operation: z.literal("logs"),
      region: z
        .string()
        .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
        .optional(),
      logGroup: z.string().min(1).max(512),
      hours: z.number().int().min(1).max(24).default(1),
      filter: z.string().max(256).default(""),
      limit: z.number().int().min(1).max(10000).default(1000),
    })
    .strict(),
  z
    .object({
      operation: z.literal("table"),
      region: z
        .string()
        .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
        .optional(),
      table: z.string().min(1).max(255),
      limit: z.number().int().min(1).max(1000).default(100),
      status: z.string().max(100).optional(),
    })
    .strict(),
]);
export type Query = z.infer<typeof querySchema>;
export const widgetSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    type: z.enum(["chart", "metric", "logs", "table", "text", "custom"]),
    title: z.string().min(1).max(120),
    description: z.string().max(500).default(""),
    width: z.enum(["half", "full"]).default("half"),
    connectorId: z.literal("aws").default("aws"),
    query: querySchema.optional(),
    series: z
      .array(
        z
          .object({ label: z.string().min(1).max(120), query: querySchema })
          .strict(),
      )
      .min(1)
      .max(12)
      .optional(),
    custom: z
      .object({
        source: z.string().min(1).max(30000),
        bindings: z
          .array(
            z
              .object({
                id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
                query: querySchema,
              })
              .strict(),
          )
          .max(4),
      })
      .strict()
      .optional(),
    threshold: z.number().min(0).max(100).optional(),
    content: z.string().max(4000).optional(),
    groupBy: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
      .optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    if (!["text", "custom"].includes(w.type) && !w.query && !w.series)
      ctx.addIssue({ code: "custom", message: "Data widgets require a query" });
    if (
      w.type === "chart" &&
      !w.series &&
      !["cpu", "aws_metric"].includes(w.query?.operation || "")
    )
      ctx.addIssue({
        code: "custom",
        message: "Charts require a CPU or AWS metric time-series query",
      });
    if (
      w.series &&
      (w.type !== "chart" ||
        w.query ||
        w.series.some(
          (s) => !["cpu", "aws_metric"].includes(s.query.operation),
        ))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "series is for charts only; use one metric query per resource and omit query",
      });
    if (
      (w.type === "custom") !== !!w.custom ||
      (w.custom && (w.query || w.series))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Custom widgets require custom source/bindings and no query or series",
      });
    if (
      w.custom &&
      new Set(w.custom.bindings.map((b) => b.id)).size !==
        w.custom.bindings.length
    )
      ctx.addIssue({ code: "custom", message: "Binding IDs must be unique" });
    if (w.type === "logs" && w.query?.operation !== "logs")
      ctx.addIssue({
        code: "custom",
        message: "Log download widgets require a logs query",
      });
  });
export const dashboardSchema = z
  .object({
    title: z.string().min(1).max(100),
    widgets: z.array(widgetSchema).max(24),
  })
  .strict()
  .refine(
    (d) => new Set(d.widgets.map((w) => w.id)).size === d.widgets.length,
    "Widget IDs must be unique",
  );
export type Dashboard = z.infer<typeof dashboardSchema>;
export type Widget = z.infer<typeof widgetSchema>;
export const emptyDashboard: Dashboard = {
  title: "Untitled dashboard",
  widgets: [],
};

// Only trusted component calls and JSON literals enter generated code. Custom source
// remains an inert string here; only the isolated QuickJS interpreter evaluates it.
export function generateDashboard(input: unknown) {
  const dashboard = dashboardSchema.parse(input);
  const literal = JSON.stringify(dashboard, null, 2)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `"use client";\nimport { DashboardGrid } from "../components/widgets";\nimport type { DashboardSpec } from "../lib/types";\n\nexport const specification = ${literal} satisfies DashboardSpec;\n\nexport default function GeneratedDashboard() {\n  return <DashboardGrid spec={specification} />;\n}\n`;
}
