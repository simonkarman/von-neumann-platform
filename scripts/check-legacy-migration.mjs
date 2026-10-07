import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { fromIni } from "@aws-sdk/credential-providers";
const d = JSON.parse(await readFile(".data/aws-deployment.json", "utf8"));
const secrets = new SecretsManagerClient({
  region: d.region,
  credentials: fromIni({ profile: d.profile }),
});
const { SecretString: password } = await secrets.send(
  new GetSecretValueCommand({ SecretId: d.AdminPasswordArn }),
);
secrets.destroy();
const login = await fetch(d.Url + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
assert.ok(login.ok);
const cookie = login.headers.get("set-cookie").split(";")[0];
async function request(route, body) {
  const r = await fetch(d.Url + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const v = await r.json();
  assert.ok(r.ok, v.error);
  return v;
}
const id = process.env.CHECK_SESSION_ID;
assert.match(
  id || "",
  /^[a-f0-9]{24}$/,
  "Set CHECK_SESSION_ID to the dashboard to test (its migration will be committed)",
);
const before = await request(`/api/sessions/${id}`);
const broken = before.dashboard.widgets.find(
  (w) => w.type === "chart" && w.query?.resourceId?.includes(","),
);
if (broken) {
  try {
    await request(`/api/sessions/${id}/start`, {});
    const deadline = Date.now() + 150000;
    for (;;) {
      const s = await request(`/api/sessions/${id}`);
      if (s.status === "failed") throw new Error(s.error);
      if (s.status === "ready") break;
      if (Date.now() > deadline) throw new Error("Startup timed out");
      await new Promise((r) => setTimeout(r, 1000));
    }
    const updated = await request(`/api/sessions/${id}`),
      w = updated.dashboard.widgets.find((w) => w.id === broken.id);
    assert.deepEqual(
      w.series.map((s) => s.query.resourceId),
      broken.query.resourceId.split(",").map((s) => s.trim()),
    );
    assert.notEqual(updated.revision, before.revision);
    console.log(
      `Verified existing dashboard repaired, preserved and committed: ${id}, ${w.series.length} separate EC2 series.`,
    );
  } finally {
    if (before.status !== "ready")
      await request(`/api/sessions/${id}/stop`, {});
  }
} else
  console.log(
    "Legacy dashboard no longer contains the comma-separated dimension bug.",
  );
