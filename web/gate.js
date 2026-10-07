const id = location.pathname.split("/")[1],
  $ = (s) => document.querySelector(s);
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
function error(message) {
  $("#status").textContent = message;
  $("#loader").hidden = true;
}
let polls = 0;
async function poll() {
  try {
    const s = await api(`/api/sessions/${id}`);
    if (s.status === "ready") {
      location.reload();
      return;
    }
    if (s.status === "failed") {
      error(s.error || "Unable to start dashboard.");
      $("#retry").hidden = !s.canEdit;
      return;
    }
    if (s.status === "stopped" && !s.canEdit) {
      error("This dashboard is asleep. Its editor needs to reopen it.");
      return;
    }
    if (s.status === "stopped" && s.canEdit)
      await api(`/api/sessions/${id}/start`, {});
    if (++polls > 180) {
      error(
        "Startup is taking longer than expected. Return to the workspace to try again.",
      );
      return;
    }
    setTimeout(poll, 1000);
  } catch (e) {
    error(e.message);
    const auth = await api("/api/auth");
    if (!auth.authenticated) {
      $("#title").textContent = "Welcome to this workspace.";
      $("#login").hidden = false;
    } else {
      $("#import").hidden = false;
    }
  }
}
$("#login").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/auth/login", {
      password: new FormData(e.target).get("password"),
    });
    location.reload();
  } catch (e) {
    error(e.message);
  }
});
$("#retry").addEventListener("click", async () => {
  await api(`/api/sessions/${id}/start`, {});
  location.reload();
});
$("#import").addEventListener("click", async () => {
  try {
    await api("/api/sessions/import", { id });
    location.reload();
  } catch (e) {
    error(e.message);
  }
});
(async () => {
  const token = new URLSearchParams(location.hash.slice(1)).get("share");
  if (token) {
    try {
      await api(`/api/sessions/${id}/share/redeem`, { token });
      history.replaceState(null, "", location.pathname);
    } catch (e) {
      error(e.message);
      return;
    }
  }
  await poll();
})().catch((e) => error(e.message));
