import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { reservePrompt } from "../server/quota.js";
test("AI quota is workspace-wide, persists in SQLite, and expires after 24 hours", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE audit (id INTEGER PRIMARY KEY, session_id TEXT, action TEXT, details TEXT, created_at TEXT)",
  );
  const now = Date.UTC(2026, 9, 6);
  assert.ok(reservePrompt(db, "one", 2, now));
  assert.ok(reservePrompt(db, "two", 2, now));
  assert.equal(reservePrompt(db, "three", 2, now), false);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM audit").get() as any).n,
    2,
  );
  assert.ok(reservePrompt(db, "three", 2, now + 86400001));
  db.close();
});
