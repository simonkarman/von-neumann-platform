import type { Query } from "./schema.js";
export function withinWidgetScope(a: Query, b: Query, defaultRegion: string) {
  if (b.operation === "log_groups") return a.operation === "logs";
  if (a.operation !== b.operation) return false;
  if (
    ("region" in a ? a.region : undefined) ||
    ("region" in b ? b.region : undefined)
  ) {
    if (
      (("region" in a ? a.region : undefined) || defaultRegion) !==
      (("region" in b ? b.region : undefined) || defaultRegion)
    )
      return false;
  }
  const aa = { ...a } as Record<string, unknown>,
    bb = { ...b } as Record<string, unknown>;
  delete aa.region;
  delete bb.region;
  if (typeof aa.limit === "number" && typeof bb.limit === "number") {
    if (bb.limit > aa.limit) return false;
    delete aa.limit;
    delete bb.limit;
  }
  if (typeof aa.hours === "number" && typeof bb.hours === "number") {
    if (bb.hours > (a.operation === "logs" ? 24 : aa.hours)) return false;
    delete aa.hours;
    delete bb.hours;
  }
  const canonical = (o: Record<string, unknown>) =>
    JSON.stringify(
      Object.entries(o)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return canonical(aa) === canonical(bb);
}
