// POST   /api/technicians          -> add engineer { name }
// DELETE /api/technicians/{name}   -> remove engineer
const { app } = require("@azure/functions");
const { query } = require("../lib/db");
const { json, listTechnicians, readJson, handle } = require("../lib/shared");

app.http("techniciansAdd", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "technicians",
  handler: handle(async (request) => {
    const b = await readJson(request);
    const name = String(b.name || "").trim().slice(0, 200);
    if (!name || name === "Unassigned") return json({ error: "Invalid name" }, 400);
    try {
      // T-SQL has no INSERT OR IGNORE; guard + ignore a duplicate-key race.
      await query(
        "IF NOT EXISTS (SELECT 1 FROM dbo.technicians WHERE name = @name) INSERT INTO dbo.technicians (name) VALUES (@name)",
        { name }
      );
    } catch (err) {
      if (err.number !== 2627 && err.number !== 2601) throw err;
    }
    return json({ technicians: await listTechnicians() });
  }),
});

app.http("techniciansRemove", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "technicians/{name}",
  handler: handle(async (request) => {
    let name = request.params.name || "";
    // Decode only if the runtime left the segment encoded (e.g. "Jo%20Smith").
    if (/%[0-9A-Fa-f]{2}/.test(name)) {
      try { name = decodeURIComponent(name); } catch { /* keep as-is */ }
    }
    await query("DELETE FROM dbo.technicians WHERE name = @name", { name });
    return json({ technicians: await listTechnicians() });
  }),
});
