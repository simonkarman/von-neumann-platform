// Repair the specific legacy bug that stored several EC2 IDs in one dimension.
// Only exact, valid EC2-ID lists are transformed. Other invalid specs still fail.
export function migrateDashboard(raw: any) {
  const copy = structuredClone(raw);
  for (const w of copy.widgets || []) {
    const q = w.query;
    if (w.type !== "chart" || !q || w.series) continue;
    const key =
      q.operation === "cpu"
        ? "instanceId"
        : q.operation === "aws_metric" && q.service === "ec2"
          ? "resourceId"
          : null;
    if (!key || typeof q[key] !== "string" || !q[key].includes(",")) continue;
    const ids = [
      ...new Set<string>(q[key].split(",").map((s: string) => s.trim())),
    ];
    if (
      ids.length > 12 ||
      !ids.every((id) => /^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(id))
    )
      continue;
    w.series = ids.map((id) => ({ label: id, query: { ...q, [key]: id } }));
    delete w.query;
  }
  return copy;
}
