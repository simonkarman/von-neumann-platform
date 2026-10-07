import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createServer } from "node:http";
import path from "node:path";
import httpProxy from "http-proxy";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "./config.js";
import { store, db } from "./store.js";
import { reservePrompt } from "./quota.js";
import { withinWidgetScope } from "./share-scope.js";
import {
  adminOnly,
  canRead,
  createShare,
  equal,
  isAdmin,
  login,
  redeemShare,
  revokeShares,
  sameOrigin,
} from "./auth.js";
import { sessionId, querySchema } from "./schema.js";
import { connectors, getConnector } from "./connectors.js";
import {
  ensureRuntime,
  exclusive,
  peekRuntime,
  shutdown,
  stopRuntime,
  settleAndStopRuntime,
  busy,
} from "./runtime.js";
import { history, restoreRevision, retrySync } from "./git.js";
import { runAgent, safeError } from "./agent.js";

export const app = express();
if (config.TRUST_PROXY_HOPS) app.set("trust proxy", config.TRUST_PROXY_HOPS);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api", express.json({ limit: "128kb" }), sameOrigin);
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/auth", (req, res) =>
  res.json({ authenticated: isAdmin(req), required: !!config.ADMIN_PASSWORD }),
);
app.post(
  "/api/auth/login",
  rateLimit({
    windowMs: 60000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  (req, res) => {
    const password = z
      .object({ password: z.string().max(1000) })
      .parse(req.body).password;
    if (config.ADMIN_PASSWORD && !equal(password, config.ADMIN_PASSWORD)) {
      res.status(401).json({ error: "Incorrect workspace password." });
      return;
    }
    login(res);
    res.json({ ok: true });
  },
);
app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("vn_admin", { path: "/" });
  res.json({ ok: true });
});
app.get("/api/config", adminOnly, (_req, res) =>
  res.json({
    provider: config.AI_PROVIDER,
    mode: config.AWS_MODE,
    runtime: config.RUNTIME_DRIVER,
    remote: !!config.DASHBOARD_REPO_URL,
    model:
      config.AI_PROVIDER === "vertex"
        ? config.VERTEX_MODEL
        : config.AI_PROVIDER === "bedrock"
          ? config.BEDROCK_MODEL
          : config.AI_PROVIDER === "openai"
            ? config.OPENAI_MODEL
            : config.COPILOT_MODEL,
    aiConfigured:
      config.AI_PROVIDER === "demo" ||
      config.AI_PROVIDER === "bedrock" ||
      (config.AI_PROVIDER === "vertex"
        ? !!config.GOOGLE_CLOUD_PROJECT
        : config.AI_PROVIDER === "openai"
          ? !!process.env.OPENAI_API_KEY
          : !!process.env.COPILOT_GITHUB_TOKEN),
  }),
);
app.get("/api/connectors", adminOnly, (_req, res) =>
  res.json([...connectors.values()].map((c) => c.describe())),
);
app.get("/api/sessions", adminOnly, (_req, res) => res.json(store.list()));
app.get("/api/trash", adminOnly, (_req, res) => res.json(store.deleted()));
app.post("/api/trash/:id/restore", adminOnly, async (req, res) => {
  const id = sessionId.parse(req.params.id);
  await exclusive(id, async () => {
    if (store.get(id, true)?.status !== "deleted")
      throw new Error("Dashboard is not in Trash");
    store.restoreDeleted(id);
    store.audit(id, "session.restored", {});
  });
  res.json(store.get(id));
});
const createLimit = rateLimit({
  windowMs: 60000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
});
app.post("/api/sessions", adminOnly, createLimit, (req, res) => {
  z.object({}).strict().parse(req.body);
  const session = store.create();
  store.audit(session.id, "session.created", {});
  void ensureRuntime(session.id).catch(() => {});
  res.status(202).json(session);
});
// Import a pushed session branch into a fresh deployment. Authorization is checked before fetching.
app.post("/api/sessions/import", adminOnly, createLimit, async (req, res) => {
  const { id } = z.object({ id: sessionId }).strict().parse(req.body);
  if (store.get(id, true)?.status === "deleted")
    throw new Error("Dashboard is in Trash; restore it there first");
  const session = store.get(id) || store.create(id);
  void ensureRuntime(id, true).catch(() => {});
  res.status(202).json(session);
});
app.post(
  "/api/sessions/:id/share/redeem",
  rateLimit({
    windowMs: 60000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  (req, res) => {
    const id = sessionId.parse(req.params.id);
    const { token } = z
      .object({ token: z.string().min(20).max(100) })
      .parse(req.body);
    redeemShare(res, id, token);
    res.json({ ok: true });
  },
);
app.use("/api/sessions/:id", (req, res, next) => {
  const id = sessionId.parse(req.params.id);
  if (!canRead(req, id)) {
    res.status(403).json({
      error: "Sign in or open a valid sharing link to view this dashboard.",
    });
    return;
  }
  if (!store.get(id)) {
    res.status(404).json({
      error: "Dashboard not found. Import its branch from the landing page.",
    });
    return;
  }
  peekRuntime(id);
  next();
});
app.get("/api/sessions/:id", (req, res) =>
  res.json({
    ...store.get(String(req.params.id)),
    canEdit: isAdmin(req),
    mode: config.AWS_MODE,
    provider: config.AI_PROVIDER,
  }),
);
app.get("/api/sessions/:id/messages", (req, res) =>
  res.json(isAdmin(req) ? store.messages(String(req.params.id)) : []),
);
app.get("/api/sessions/:id/history", async (req, res) =>
  res.json(await history(String(req.params.id))),
);
app.get("/api/sessions/:id/audit", adminOnly, (req, res) =>
  res.json(store.audits(String(req.params.id))),
);
app.post("/api/sessions/:id/start", adminOnly, async (req, res) => {
  const id = String(req.params.id);
  void ensureRuntime(id).catch(() => {});
  res.status(202).json(store.get(id));
});
app.post("/api/sessions/:id/stop", adminOnly, async (req, res) => {
  const id = String(req.params.id);
  await exclusive(id, () => stopRuntime(id));
  res.json(store.get(id));
});
app.post("/api/sessions/:id/delete", adminOnly, async (req, res) => {
  const id = String(req.params.id);
  await exclusive(id, async () => {
    revokeShares(id);
    store.status(id, "deleted");
    await settleAndStopRuntime(id);
    store.audit(id, "session.deleted", { recoverable: true });
  });
  res.json({ ok: true, recoverable: true });
});
app.post("/api/sessions/:id/share", adminOnly, (req, res) => {
  const id = String(req.params.id);
  store.audit(id, "share.created", {});
  res.json(createShare(id));
});
app.post("/api/sessions/:id/share/revoke", adminOnly, (req, res) => {
  revokeShares(String(req.params.id));
  res.json({ ok: true });
});
app.post("/api/sessions/:id/restore", adminOnly, async (req, res) => {
  const id = String(req.params.id);
  const { revision } = z.object({ revision: z.string() }).parse(req.body);
  const result = await exclusive(id, async () => {
    await ensureRuntime(id);
    return restoreRevision(id, revision);
  });
  res.json(result);
});
app.post("/api/sessions/:id/sync", adminOnly, async (req, res) => {
  const id = String(req.params.id);
  await exclusive(id, () => retrySync(id));
  res.json({ ok: true });
});
const queryLimit = rateLimit({
  windowMs: 60000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
const queryBody = z
  .object({ connectorId: z.string().max(40), query: querySchema })
  .strict();
function authorizeQuery(req: Request, query: z.infer<typeof queryBody>) {
  if (isAdmin(req)) return;
  // Viewers may only read resources already exposed by this shared dashboard.
  const session = store.get(String(req.params.id))!;
  const matches = session.dashboard.widgets.some((w) => {
    if (w.connectorId !== query.connectorId) return false;
    return [
      w.query,
      ...(w.series || []).map((s) => s.query),
      ...(w.custom?.bindings || []).map((b) => b.query),
    ].some((a) => a && withinWidgetScope(a, query.query, config.AWS_REGION));
  });
  if (!matches)
    throw new Error("This query is outside the shared dashboard’s scope.");
}
app.post(
  "/api/sessions/:id/custom/:widgetId/data",
  queryLimit,
  async (req, res) => {
    z.object({}).strict().parse(req.body);
    const widget = store
      .get(String(req.params.id))!
      .dashboard.widgets.find(
        (w) => w.id === req.params.widgetId && w.type === "custom",
      );
    if (!widget?.custom) throw new Error("Custom widget not found");
    const data: Record<string, unknown> = {};
    for (const binding of widget.custom.bindings)
      data[binding.id] = await getConnector(widget.connectorId).query(
        binding.query,
      );
    if (JSON.stringify(data).length > 250000)
      throw new Error(
        "Custom data limit exceeded; reduce binding query limits",
      );
    res.json(data);
  },
);
app.post("/api/sessions/:id/query", queryLimit, async (req, res) => {
  const args = queryBody.parse(req.body);
  authorizeQuery(req, args);
  if (!isAdmin(req) && args.query.operation === "log_groups") {
    res.json({
      items: store
        .get(String(req.params.id))!
        .dashboard.widgets.flatMap((w) =>
          w.query?.operation === "logs" ? [{ name: w.query.logGroup }] : [],
        ),
    });
    return;
  }
  const result = await getConnector(args.connectorId).query(args.query);
  store.audit(String(req.params.id), "connector.query", {
    operation: args.query.operation,
    connectorId: args.connectorId,
  });
  res.json(result);
});
app.post("/api/sessions/:id/logs/download", queryLimit, async (req, res) => {
  const args = queryBody.parse(req.body);
  if (args.query.operation !== "logs")
    throw new Error("Only log queries can be downloaded.");
  authorizeQuery(req, args);
  const data = await getConnector(args.connectorId).query(args.query);
  store.audit(String(req.params.id), "logs.download", {
    rows: data.items.length,
    truncated: data.truncated,
  });
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="cloudwatch-logs.jsonl"',
  );
  res.setHeader("X-Results-Truncated", String(data.truncated));
  res
    .type("application/x-ndjson")
    .send(
      data.items.map((item: any) => JSON.stringify(item)).join("\n") + "\n",
    );
});
app.post(
  "/api/sessions/:id/prompt",
  adminOnly,
  rateLimit({
    windowMs: 60000,
    limit: 15,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  async (req, res) => {
    const { prompt } = z
      .object({ prompt: z.string().trim().min(1).max(8000) })
      .strict()
      .parse(req.body);
    const id = String(req.params.id);
    await exclusive(id, async () => {
      if (!reservePrompt(db, id, config.MAX_DAILY_PROMPTS)) {
        res.status(429).json({
          error:
            "Workspace AI request limit reached for the last 24 hours. Try later or ask the administrator to raise MAX_DAILY_PROMPTS.",
        });
        return;
      }
      await ensureRuntime(id);
      res.status(200).set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), 240000);
      const heartbeat = setInterval(() => {
        if (!res.destroyed) res.write(": heartbeat\n\n");
      }, 15000);
      res.on("close", () => controller.abort());
      try {
        await runAgent(
          id,
          prompt,
          (event) => {
            if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
          },
          controller.signal,
        );
      } finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        res.end();
      }
    });
  },
);
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Unknown endpoint." }),
);
app.use(express.static(path.resolve("web"), { index: false }));
app.get("/", (_req, res) => res.sendFile(path.resolve("web/index.html")));
const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: false });
proxy.on("error", (_error, _req, res) => {
  if ("writeHead" in res && !res.headersSent)
    res.writeHead(502, { "Content-Type": "text/plain" });
  res.end("Dashboard runtime is unavailable. Reload to restart it.");
});
// Session and all of its _next assets use the exact same prefix. HMR websocket upgrades are authenticated too.
app.use(async (req, res, next) => {
  const id = req.path.split("/")[1];
  if (!sessionId.safeParse(id).success) {
    next();
    return;
  }
  const session = store.get(id);
  if (!session || !canRead(req, id)) {
    res.sendFile(path.resolve("web/session-gate.html"));
    return;
  }
  const suffix = req.path.slice(id.length + 1);
  if (
    ["GET", "HEAD"].includes(req.method) &&
    ["/custom/worker.mjs", "/custom/engine.mjs"].includes(suffix)
  ) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'",
    );
    res
      .type("text/javascript")
      .sendFile(path.join(config.DASHBOARD_TEMPLATE_DIR, "public", suffix));
    return;
  }
  if (
    !["GET", "HEAD"].includes(req.method) ||
    (suffix !== "" && suffix !== "/" && !suffix.startsWith("/_next/static/"))
  ) {
    res.status(404).send("Endpoint not exposed.");
    return;
  }
  const runtime = peekRuntime(id);
  if (!runtime) {
    if (session.status === "failed" && !isAdmin(req)) {
      res
        .status(503)
        .send("The dashboard is unavailable. Ask its editor to restart it.");
      return;
    }
    void ensureRuntime(id).catch(() => {});
    res.sendFile(path.resolve("web/session-gate.html"));
    return;
  }
  proxy.web(req, res, { target: runtime.target });
});
app.use((_req, res) => res.status(404).send("Page not found."));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    res.end();
    return;
  }
  res
    .status(error instanceof z.ZodError ? 400 : 409)
    .json({ error: safeError(error) });
});
export const server = createServer(app);
server.on("upgrade", (req, socket, head) => {
  const id = (req.url || "").split("/")[1];
  const origin = req.headers.origin;
  if (!/\/_next\/(?:webpack-hmr|hmr)$/.test((req.url || "").split("?")[0])) {
    socket.destroy();
    return;
  }
  if (
    !sessionId.safeParse(id).success ||
    !canRead(req, id) ||
    (origin && origin !== new URL(config.PUBLIC_URL).origin)
  ) {
    socket.destroy();
    return;
  }
  const runtime = peekRuntime(id);
  if (!runtime) {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: runtime.target });
});
server.listen(config.PORT, config.HOST, () =>
  console.log(
    `Von Neumann is ready at ${config.PUBLIC_URL} (${config.AI_PROVIDER} / ${config.AWS_MODE} data)`,
  ),
);
async function close() {
  server.close();
  await shutdown();
  server.closeAllConnections();
  process.exit(0);
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
