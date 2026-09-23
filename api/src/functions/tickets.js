// POST   /api/tickets              -> create ticket
// PATCH  /api/tickets/{id}         -> update fields (server writes audit notes)
// DELETE /api/tickets/{id}         -> delete ticket + its notes
// POST   /api/tickets/{id}/notes   -> add a manual work note
const { app } = require("@azure/functions");
const { query, withTx, ts } = require("../lib/db");
const {
  CATEGORIES, PRIORITIES, STATUSES, REQUEST_TYPES,
  json, getTicket, readJson, handle,
} = require("../lib/shared");

app.http("ticketsCreate", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "tickets",
  handler: handle(async (request) => {
    const b = await readJson(request);
    if (!b.subject || !String(b.subject).trim()) return json({ error: "Subject is required" }, 400);
    const now = new Date();
    const rows = await query(
      `INSERT INTO dbo.tickets
         (subject, description, requester, category, sub_category, request_type, priority, status, assignee, created_at, updated_at)
       OUTPUT INSERTED.id
       VALUES (@subject, @description, @requester, @category, @subCategory, @requestType, @priority, N'Open', N'Unassigned', @now, @now)`,
      {
        subject: String(b.subject).trim().slice(0, 300),
        description: String(b.description || "").trim(),
        requester: String(b.requester || "").trim().slice(0, 200),
        category: CATEGORIES.includes(b.category) ? b.category : "Other",
        subCategory: String(b.subCategory || "").trim().slice(0, 60),
        requestType: REQUEST_TYPES.includes(b.requestType) ? b.requestType : "Incident",
        priority: PRIORITIES.includes(b.priority) ? b.priority : "Medium",
        now: ts(now),
      }
    );
    return json(await getTicket(rows[0].id), 201);
  }),
});

app.http("ticketNotes", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "tickets/{id:int}/notes",
  handler: handle(async (request) => {
    const id = Number(request.params.id);
    const b = await readJson(request);
    if (!b.text || !String(b.text).trim()) return json({ error: "Note text is required" }, 400);
    const exists = await query("SELECT id FROM dbo.tickets WHERE id = @id", { id });
    if (!exists.length) return json({ error: "Ticket not found" }, 404);
    const now = new Date();
    await withTx(async (tx) => {
      await query(
        "INSERT INTO dbo.notes (ticket_id, [text], [at], [system]) VALUES (@id, @text, @now, 0)",
        { id, text: String(b.text).trim(), now: ts(now) }, tx
      );
      await query("UPDATE dbo.tickets SET updated_at = @now WHERE id = @id", { id, now: ts(now) }, tx);
    });
    return json(await getTicket(id));
  }),
});

// Fields the PATCH accepts. The keys double as the SQL column whitelist —
// only these names are ever interpolated into the UPDATE statement.
const allowedValues = {
  status: STATUSES,
  assignee: null,      // any name; UI restricts to roster
  priority: PRIORITIES,
  category: CATEGORIES,
  request_type: REQUEST_TYPES,
  sub_category: null,  // free text; UI restricts to taxonomy
  subject: null,
  description: null,
  requester: null,
};
const fieldLabels = {
  status: "Status", assignee: "Technician", priority: "Priority", category: "Category",
  request_type: "Request type", sub_category: "Sub category", subject: "Subject",
  description: "Description", requester: "Requester",
};
const textCaps = { sub_category: 60, subject: 300, requester: 200, description: 20000 };

app.http("ticketById", {
  methods: ["PATCH", "DELETE"],
  authLevel: "anonymous",
  route: "tickets/{id:int}",
  handler: handle(async (request) => {
    const id = Number(request.params.id);

    if (request.method === "DELETE") {
      // notes also cascade via FK_notes_tickets; explicit delete kept for clarity
      await withTx(async (tx) => {
        await query("DELETE FROM dbo.notes WHERE ticket_id = @id", { id }, tx);
        await query("DELETE FROM dbo.tickets WHERE id = @id", { id }, tx);
      });
      return json({ ok: true });
    }

    // PATCH — update fields with automatic audit trail.
    // Future: restrict subject/description/requester edits to admins by
    // checking getUserEmail(request) against an ADMIN_EMAILS app setting.
    const b = await readJson(request);
    const currentRows = await query("SELECT * FROM dbo.tickets WHERE id = @id", { id });
    if (!currentRows.length) return json({ error: "Ticket not found" }, 404);
    const current = currentRows[0];
    const now = new Date();

    const updates = {};
    const changes = [];
    for (const f of Object.keys(allowedValues)) {
      if (b[f] === undefined) continue;
      let v = b[f];
      if (textCaps[f] !== undefined) v = String(v).trim().slice(0, textCaps[f]);
      if (f === "subject" && !v) return json({ error: "Subject cannot be empty" }, 400);
      if (v === current[f] || (v === "" && !current[f])) continue;
      const allowed = allowedValues[f];
      if (allowed && !allowed.includes(v)) return json({ error: "Invalid value for " + f }, 400);
      updates[f] = v;
      changes.push(
        f === "description"
          ? "Description updated"
          : fieldLabels[f] + ": " + (current[f] || "—") + " → " + (v || "—")
      );
    }

    let resolvedAt = current.resolved_at || null;
    if (updates.status === "Resolved" && current.status !== "Resolved") resolvedAt = now;
    if (updates.status && updates.status !== "Resolved") resolvedAt = null;

    if (Object.keys(updates).length) {
      const params = { id, resolvedAt: ts(resolvedAt), now: ts(now) };
      const setClauses = Object.keys(updates).map((f) => {
        params["v_" + f] = String(updates[f]);
        return f + " = @v_" + f;
      });
      await withTx(async (tx) => {
        await query(
          "UPDATE dbo.tickets SET " + setClauses.join(", ") +
            ", resolved_at = @resolvedAt, updated_at = @now WHERE id = @id",
          params, tx
        );
        await query(
          "INSERT INTO dbo.notes (ticket_id, [text], [at], [system]) VALUES (@id, @text, @now, 1)",
          { id, text: changes.join(" · "), now: ts(now) }, tx
        );
      });
    }
    return json(await getTicket(id));
  }),
});
