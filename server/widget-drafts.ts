import { db, store } from "./store.js";
import { widgetSchema, type Widget } from "./schema.js";
import { testCustomWidget } from "./custom.js";
export function saveDraft(id: string, raw: unknown) {
  const widget = widgetSchema.parse(raw);
  if (widget.type !== "custom")
    throw new Error("Use update_dashboard for standard widgets");
  const revision = store.get(id)!.revision;
  db.prepare(
    "INSERT OR REPLACE INTO widget_drafts(session_id,widget_id,widget,base_revision) VALUES (?,?,?,?)",
  ).run(id, widget.id, JSON.stringify(widget), revision);
  store.audit(id, "custom.drafted", { widgetId: widget.id });
  return { widgetId: widget.id, baseRevision: revision, published: false };
}
export function readDraft(id: string, widgetId: string): Widget {
  const row = db
    .prepare("SELECT * FROM widget_drafts WHERE session_id=? AND widget_id=?")
    .get(id, widgetId);
  if (!row) throw new Error("Draft not found; use draft_widget first");
  if (row.base_revision !== store.get(id)!.revision)
    throw new Error(
      "Dashboard changed since this draft. Read the dashboard and re-draft before publishing.",
    );
  return widgetSchema.parse(JSON.parse(String(row.widget)));
}
export async function testDraft(id: string, widgetId: string) {
  const widget = readDraft(id, widgetId);
  const result = await testCustomWidget(widget);
  store.audit(id, "custom.tested", { widgetId, checks: result.checks });
  return {
    widgetId,
    passed: true,
    checks: result.checks,
    preview: result.result.view,
  };
}
