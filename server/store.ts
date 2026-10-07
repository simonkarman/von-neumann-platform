import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { emptyDashboard, type Dashboard } from "./schema.js";

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  error: string | null;
  revision: string | null;
  syncStatus: string;
  dashboard: Dashboard;
}
export interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(
  path.join(config.DATA_DIR, "platform.sqlite"),
);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL, error TEXT, revision TEXT, sync_status TEXT NOT NULL DEFAULT 'local', dashboard TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT REFERENCES sessions(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shares (hash TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, session_id TEXT, action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS audit_action_date ON audit(action,created_at);
CREATE TABLE IF NOT EXISTS widget_drafts (session_id TEXT NOT NULL REFERENCES sessions(id), widget_id TEXT NOT NULL, widget TEXT NOT NULL, base_revision TEXT, PRIMARY KEY(session_id,widget_id));
`);
db.prepare(
  "UPDATE sessions SET status='stopped' WHERE status IN ('starting','ready')",
).run();
function decode(row: any): Session {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    error: row.error,
    revision: row.revision,
    syncStatus: row.sync_status,
    dashboard: JSON.parse(row.dashboard),
  };
}
export const store = {
  create(id = randomBytes(12).toString("hex")) {
    if (
      (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as any).n >=
      config.MAX_SESSIONS
    )
      throw new Error("Session storage limit reached.");
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO sessions (id,title,created_at,updated_at,status,dashboard) VALUES (?,?,?,?,?,?)",
    ).run(
      id,
      emptyDashboard.title,
      now,
      now,
      "starting",
      JSON.stringify(emptyDashboard),
    );
    return this.get(id)!;
  },
  get(id: string, includeDeleted = false): Session | undefined {
    const row = db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
    return row && (includeDeleted || row.status !== "deleted")
      ? decode(row)
      : undefined;
  },
  list(): Session[] {
    return db
      .prepare(
        "SELECT * FROM sessions WHERE status != 'deleted' ORDER BY updated_at DESC",
      )
      .all()
      .map(decode);
  },
  deleted(): Session[] {
    return db
      .prepare(
        "SELECT * FROM sessions WHERE status='deleted' ORDER BY updated_at DESC",
      )
      .all()
      .map(decode);
  },
  status(id: string, status: string, error: string | null = null) {
    db.prepare("UPDATE sessions SET status=?,error=? WHERE id=? AND status != 'deleted'").run(
      status,
      error,
      id,
    );
  },
  restoreDeleted(id: string) {
    db.prepare("UPDATE sessions SET status='stopped',error=NULL WHERE id=? AND status='deleted'").run(id);
  },
  update(
    id: string,
    dashboard: Dashboard,
    revision: string,
    syncStatus: string,
  ) {
    db.prepare(
      "UPDATE sessions SET title=?,dashboard=?,revision=?,sync_status=?,updated_at=? WHERE id=?",
    ).run(
      dashboard.title,
      JSON.stringify(dashboard),
      revision,
      syncStatus,
      new Date().toISOString(),
      id,
    );
  },
  messages(id: string): Message[] {
    return db
      .prepare(
        "SELECT id,role,content,created_at AS createdAt FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 100",
      )
      .all(id)
      .reverse() as unknown as Message[];
  },
  message(id: string, role: Message["role"], content: string) {
    db.prepare(
      "INSERT INTO messages (session_id,role,content,created_at) VALUES (?,?,?,?)",
    ).run(id, role, content, new Date().toISOString());
  },
  audit(id: string | null, action: string, details: unknown) {
    db.prepare(
      "INSERT INTO audit (session_id,action,details,created_at) VALUES (?,?,?,?)",
    ).run(id, action, JSON.stringify(details), new Date().toISOString());
  },
  audits(id: string) {
    return db
      .prepare(
        "SELECT action,details,created_at AS createdAt FROM audit WHERE session_id=? ORDER BY id DESC LIMIT 100",
      )
      .all(id);
  },
};
