// GET /api/prefs/tabs  -> per-engineer status tab layout
// PUT /api/prefs/tabs  -> save status tab layout
// Keyed by the signed-in Entra user (SWA auth) instead of Cloudflare Access.
const { app } = require("@azure/functions");
const { query, ts } = require("../lib/db");
const { STATUSES, json, getUserEmail, readJson, handle } = require("../lib/shared");

app.http("prefsTabs", {
  methods: ["GET", "PUT"],
  authLevel: "anonymous",
  route: "prefs/tabs",
  handler: handle(async (request) => {
    const userEmail = getUserEmail(request);

    if (request.method === "GET") {
      const rows = await query(
        "SELECT tabs_json FROM dbo.user_tab_prefs WHERE user_email = @userEmail",
        { userEmail }
      );
      let tabs = null;
      if (rows.length) {
        try { tabs = JSON.parse(rows[0].tabs_json); } catch { tabs = null; }
      }
      return json({ tabs });
    }

    const b = await readJson(request);
    const tabs = Array.isArray(b.tabs) ? b.tabs : null;
    const validKeys = [...STATUSES, "Overdue"];
    const ok =
      tabs && tabs.length &&
      tabs.some((t) => t && t.on) &&
      tabs.every((t) => t && validKeys.includes(t.key) && typeof t.on === "boolean");
    if (!ok) {
      return json({ error: "tabs must be a non-empty array of { key, on } with at least one enabled" }, 400);
    }

    // Upsert (SQLite ON CONFLICT ... DO UPDATE). The lock hints stop two
    // simultaneous saves from both trying to INSERT.
    await query(
      `UPDATE dbo.user_tab_prefs WITH (UPDLOCK, SERIALIZABLE)
         SET tabs_json = @tabsJson, updated_at = @now
       WHERE user_email = @userEmail;
       IF @@ROWCOUNT = 0
         INSERT INTO dbo.user_tab_prefs (user_email, tabs_json, updated_at)
         VALUES (@userEmail, @tabsJson, @now);`,
      { userEmail, tabsJson: JSON.stringify(tabs), now: ts(new Date()) }
    );
    return json({ ok: true, tabs });
  }),
});
