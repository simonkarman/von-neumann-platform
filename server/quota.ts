import type { DatabaseSync } from "node:sqlite";
// Synchronous reservation: no other request in this single-process backend can
// pass the check before the audit row is inserted. Persists across restarts.
export function reservePrompt(
  db: DatabaseSync,
  id: string,
  limit: number,
  now = Date.now(),
) {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action='agent.started' AND created_at>=?",
    )
    .get(new Date(now - 86400000).toISOString()) as { n: number };
  if (row.n >= limit) return false;
  db.prepare(
    "INSERT INTO audit (session_id,action,details,created_at) VALUES (?,'agent.started','{}',?)",
  ).run(id, new Date(now).toISOString());
  return true;
}
