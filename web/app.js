const $ = (selector) => document.querySelector(selector);
async function api(url, body) {
  const r = await fetch(
    url,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "The request failed.");
  return data;
}
const notice = (text) => {
  $("#notice").hidden = !text;
  $("#notice").textContent = text;
};
async function create() {
  try {
    $("#create").disabled = true;
    const s = await api("/api/sessions", {});
    location.href = `/${s.id}`;
  } catch (e) {
    notice(e.message);
    $("#create").disabled = false;
  }
}
for (const id of ["#create", "#nav-new", "#welcome-new"])
  $(id).addEventListener("click", create);
$("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", {});
  location.reload();
});
$("#import-button").addEventListener("click", () =>
  $("#import-dialog").showModal(),
);
$("#close-import").addEventListener("click", () => $("#import-dialog").close());
$("#import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = new FormData(e.target).get("id");
  try {
    const session = await api("/api/sessions/import", { id });
    location.href = `/${session.id}`;
  } catch (error) {
    $("#import-dialog").close();
    notice(error.message);
  }
});
$("#login-dialog").addEventListener("cancel", (e) => e.preventDefault());
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/auth/login", {
      password: new FormData(e.target).get("password"),
    });
    $("#login-dialog").close();
    await load();
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
});
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
async function load() {
  const auth = await api("/api/auth");
  if (!auth.authenticated) {
    $("#login-dialog").showModal();
    return;
  }
  $("#logout").hidden = !auth.required;
  const [sessions, config] = await Promise.all([
    api("/api/sessions"),
    api("/api/config"),
  ]);
  $("#count").textContent = sessions.length;
  $("#connector-mode").textContent =
    config.mode === "demo"
      ? "Demo connector · sample data"
      : "Live · restricted access";
  $("#provider-label").textContent =
    config.provider === "vertex"
      ? "Vertex AI · Application Default Credentials"
      : config.provider === "bedrock"
        ? "Amazon Bedrock · IAM role"
        : config.provider === "demo"
          ? "Demo assistant · no API key needed"
          : config.provider === "copilot"
            ? "GitHub Copilot"
            : "OpenAI";
  if (!config.aiConfigured)
    notice(
      "Your workspace is ready. Configure Google Cloud ADC and GOOGLE_CLOUD_PROJECT to connect the assistant, or set AI_PROVIDER=demo to explore.",
    );
  const grid = $("#sessions");
  grid.replaceChildren();
  for (const s of sessions) {
    const card = element("article", "session-card"),
      link = element("a");
    link.href = `/${s.id}`;
    link.append(
      element("span", "session-icon", s.dashboard.widgets.length ? "▤" : "▧"),
      element("h3", "", s.title),
      element(
        "p",
        "",
        `${s.dashboard.widgets.length} elements · ${new Date(s.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
      ),
    );
    const footer = element("footer"),
      status = element("span");
    status.append(
      element("span", "dot"),
      element(
        "span",
        "",
        s.status === "ready"
          ? "Running"
          : s.status === "failed"
            ? "Needs attention"
            : s.status === "starting"
              ? "Starting…"
              : "Saved",
      ),
    );
    footer.append(status);
    if (s.status === "ready") {
      const stop = element("button", "stop-button", "Stop session");
      stop.addEventListener("click", async () => {
        try {
          await api(`/api/sessions/${s.id}/stop`, {});
          await load();
        } catch (e) {
          notice(e.message);
        }
      });
      footer.append(stop);
    } else footer.append(element("span", "", s.revision?.slice(0, 7) || "New"));
    card.append(link, footer);
    const remove = element("button", "stop-button", "Delete dashboard");
    remove.addEventListener("click", async () => {
      if (
        !confirm(
          `Move “${s.title}” to Trash? Sharing links will be revoked. No AWS resources are deleted. You can restore this dashboard later.`,
        )
      )
        return;
      try {
        await api(`/api/sessions/${s.id}/delete`, {});
        notice(
          "Dashboard moved to Trash. Files and Git history retained for recovery.",
        );
        await load();
      } catch (e) {
        notice(e.message);
      }
    });
    card.append(remove);
    grid.append(card);
  }
  const add = element("button", "session-card new-card");
  add.append(
    element("span", "plus-circle", "+"),
    element("strong", "", "Create a dashboard"),
    element("small", "", "A fresh canvas for your next question"),
  );
  add.addEventListener("click", create);
  grid.append(add);
  const deleted = await api("/api/trash");
  if (deleted.length) {
    const trash = element("details", "trash"),
      label = element("summary", "", `Trash (${deleted.length})`);
    trash.append(label);
    for (const s of deleted) {
      const row = element("div", "trash-row"),
        restore = element("button", "stop-button", "Restore dashboard");
      row.append(element("span", "", s.title), restore);
      restore.addEventListener("click", async () => {
        try {
          await api(`/api/trash/${s.id}/restore`, {});
          await load();
        } catch (e) {
          notice(e.message);
        }
      });
      trash.append(row);
    }
    grid.append(trash);
  }
}
load().catch((e) => notice(e.message));
