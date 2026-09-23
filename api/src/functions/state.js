// GET /api/state -> { tickets, technicians }
const { app } = require("@azure/functions");
const { query } = require("../lib/db");
const { json, rowToTicket, noteOut, listTechnicians, handle } = require("../lib/shared");

app.http("state", {
  methods: ["GET"],
  authLevel: "anonymous", // access is enforced by staticwebapp.config.json
  route: "state",
  handler: handle(async () => {
    const tickets = await query("SELECT * FROM dbo.tickets ORDER BY id DESC");
    const notes = await query("SELECT ticket_id, [text], [at], [system] FROM dbo.notes ORDER BY id");
    const byTicket = {};
    for (const n of notes) (byTicket[n.ticket_id] = byTicket[n.ticket_id] || []).push(noteOut(n));
    return json({
      tickets: tickets.map((r) => rowToTicket(r, byTicket[r.id])),
      technicians: await listTechnicians(),
    });
  }),
});
