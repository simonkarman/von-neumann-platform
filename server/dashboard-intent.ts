import type { Dashboard } from "./schema.js";
// Narrow guard for an explicit graph request with named EC2 IDs. Do not reinterpret
// ambiguous requests, removals, generic metric cards, or unrelated existing widgets.
export function validateRequestedCharts(prompt: string, dashboard: Dashboard) {
  if (!/\bcpu\b/i.test(prompt)) return;
  if (
    !/\b(?:add|create|show|plot|draw|build)\b[\s\S]*\b(?:graph|chart|trend)\b/i.test(
      prompt,
    ) ||
    /\b(?:remove|delete|instead)\b|\bdo not\b|don't/i.test(prompt)
  )
    return;
  const ids = new Set(prompt.match(/\bi-[a-f0-9]{8,17}\b/g) || []);
  if (!ids.size) return;
  for (const requested of ids) {
    if (
      !dashboard.widgets.some(
        (w) =>
          w.type === "chart" &&
          [w.query, ...(w.series || []).map((s) => s.query)].some(
            (q) =>
              (q?.operation === "cpu" && q.instanceId === requested) ||
              (q?.operation === "aws_metric" &&
                q.service === "ec2" &&
                q.metric === "CPUUtilization" &&
                q.resourceId === requested),
          ),
      )
    )
      throw new Error(
        `The user requested a CPU graph for ${requested}. Set the widget's type to 'chart' with a CPU time-series query; 'metric' renders only one number. Save the correction and preserve other widgets.`,
      );
  }
}
