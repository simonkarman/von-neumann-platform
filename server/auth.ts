import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { db } from "./store.js";

const secretFile = path.join(config.DATA_DIR, "cookie-secret");
let localSecret: string;
try {
  localSecret = readFileSync(secretFile, "utf8");
} catch {
  localSecret = randomBytes(32).toString("hex");
  writeFileSync(secretFile, localSecret, { mode: 0o600, flag: "wx" });
}
const secret = config.SESSION_SECRET || localSecret;
const secure = new URL(config.PUBLIC_URL).protocol === "https:";
export function equal(a: string, b: string) {
  const aa = createHash("sha256").update(a).digest(),
    bb = createHash("sha256").update(b).digest();
  return timingSafeEqual(aa, bb);
}
const sign = (value: string) =>
  createHmac("sha256", secret).update(value).digest("base64url");
function token(scope: string, ttl: number) {
  const body = Buffer.from(
    JSON.stringify({ scope, expires: Date.now() + ttl }),
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}
function cookies(req: { headers: { cookie?: string } }) {
  return Object.fromEntries(
    (req.headers.cookie || "").split(";").map((p) => p.trim().split("=")),
  );
}
function check(value: string | undefined, scope: string) {
  if (!value) return false;
  const [body, mac] = value.split(".");
  if (!body || !mac || !equal(sign(body), mac)) return false;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    return data.scope === scope && data.expires > Date.now();
  } catch {
    return false;
  }
}
export function isAdmin(req: { headers: { cookie?: string } }) {
  return !config.ADMIN_PASSWORD || check(cookies(req).vn_admin, "admin");
}
export function canRead(req: { headers: { cookie?: string } }, id: string) {
  if (isAdmin(req)) return true;
  const value = cookies(req)[`vn_view_${id}`];
  if (!value) return false;
  // Cookie contains the signed share hash; revoke invalidates existing viewer cookies too.
  const hash = value.split("~")[0];
  return (
    check(value.split("~")[1], `view:${id}:${hash}`) &&
    !!db
      .prepare(
        "SELECT hash FROM shares WHERE hash=? AND session_id=? AND expires_at>?",
      )
      .get(hash, id, Date.now())
  );
}
export function login(res: Response) {
  res.cookie("vn_admin", token("admin", 7 * 86400000), {
    httpOnly: true,
    sameSite: "strict",
    secure,
    maxAge: 7 * 86400000,
    path: "/",
  });
}
export function adminOnly(req: Request, res: Response, next: NextFunction) {
  if (!isAdmin(req)) {
    res.status(401).json({ error: "Sign in to edit this workspace." });
    return;
  }
  next();
}
export function sameOrigin(req: Request, res: Response, next: NextFunction) {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && origin !== new URL(config.PUBLIC_URL).origin) {
      res.status(403).json({ error: "Cross-origin request rejected." });
      return;
    }
    if (req.headers["sec-fetch-site"] === "cross-site") {
      res.status(403).json({ error: "Cross-site request rejected." });
      return;
    }
    // All browser mutations must be JSON; blocks form-based CSRF when Origin is absent.
    if (!req.is("application/json")) {
      res.status(415).json({ error: "Use application/json." });
      return;
    }
  }
  next();
}
export function createShare(id: string) {
  const raw = randomBytes(32).toString("base64url"),
    hash = createHash("sha256").update(raw).digest("hex"),
    expiresAt = Date.now() + 7 * 86400000;
  db.prepare(
    "INSERT INTO shares (hash,session_id,expires_at) VALUES (?,?,?)",
  ).run(hash, id, expiresAt);
  return {
    url: `${config.PUBLIC_URL.replace(/\/$/, "")}/${id}#share=${raw}`,
    expiresAt,
  };
}
export function redeemShare(res: Response, id: string, raw: string) {
  const hash = createHash("sha256").update(raw).digest("hex");
  const share = db
    .prepare(
      "SELECT expires_at FROM shares WHERE hash=? AND session_id=? AND expires_at>?",
    )
    .get(hash, id, Date.now()) as any;
  if (!share) throw new Error("This sharing link is invalid or expired.");
  const ttl = Number(share.expires_at) - Date.now();
  res.cookie(`vn_view_${id}`, `${hash}~${token(`view:${id}:${hash}`, ttl)}`, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    maxAge: ttl,
    path: "/",
  });
}
export function revokeShares(id: string) {
  db.prepare("DELETE FROM shares WHERE session_id=?").run(id);
}
