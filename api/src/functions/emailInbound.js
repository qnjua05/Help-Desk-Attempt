// POST /api/email/inbound  -> create a ticket or append a reply note
//
// Replaces the Worker's `email` handler (Cloudflare Email Routing).
// Called by the Logic App that watches the support mailbox — set up later.
// Excluded from sign-in in staticwebapp.config.json, so it is protected by
// a shared secret instead: the caller must send header
//   x-ingest-key: <EMAIL_INGEST_KEY app setting>
// With no EMAIL_INGEST_KEY configured the endpoint stays closed (501).
//
// Expected JSON body (Logic App maps its trigger outputs to these):
//   messageId       Internet Message-ID           (required, dedup key)
//   conversationId  Exchange/Graph conversation id (threading)
//   fromAddress, fromName, subject
//   bodyHtml or bodyText
//   inReplyTo, references  (optional, raw header values if available)
//   autoSubmitted          (optional, raw Auto-Submitted header)
const crypto = require("crypto");
const { app } = require("@azure/functions");
const { query, withTx, ts } = require("../lib/db");
const { json, readJson, handle } = require("../lib/shared");
const { htmlToText, tidy, cleanEmailBody } = require("../lib/emailClean");

function keyMatches(given, expected) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const AUTO_REPLY_SUBJECT = /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|undeliverable|delivery status notification)\b/i;

app.http("emailInbound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "email/inbound",
  handler: handle(async (request) => {
    const expected = process.env.EMAIL_INGEST_KEY;
    if (!expected) return json({ error: "Email ingestion is not configured" }, 501);
    if (!keyMatches(request.headers.get("x-ingest-key"), expected)) return json({ error: "Unauthorized" }, 401);

    const p = await readJson(request);
    const subject = String(p.subject || "(no subject)").slice(0, 300);

    // Ignore auto-generated mail (bounces, out-of-office) to avoid loops.
    if (p.autoSubmitted && String(p.autoSubmitted).toLowerCase() !== "no") return json({ skipped: "auto-submitted" });
    if (AUTO_REPLY_SUBJECT.test(subject)) return json({ skipped: "auto-reply" });

    const now = new Date();
    const fromAddr = String(p.fromAddress || "unknown").slice(0, 320);
    const fromName = String(p.fromName || fromAddr);
    const bodyText = tidy(cleanEmailBody(p.bodyText || htmlToText(p.bodyHtml), fromName, fromAddr));
    const messageId = String(p.messageId || "no-id-" + crypto.randomUUID()).slice(0, 300);

    // Idempotency: skip anything already processed (Logic Apps can retry).
    const seen = await query("SELECT 1 AS x FROM dbo.email_ingest_log WHERE graph_message_id = @messageId", { messageId });
    if (seen.length) return json({ skipped: "duplicate" });

    const refs = []
      .concat(Array.isArray(p.references) ? p.references : String(p.references || "").split(/\s+/))
      .concat(p.inReplyTo ? [p.inReplyTo] : [])
      .map((r) => String(r).trim())
      .filter(Boolean)
      .slice(-20);
    const conversationId = String(p.conversationId || refs[0] || messageId).slice(0, 300);

    // Thread match: same Exchange conversation, or a reply to a message we stored.
    const params = { conversationId };
    const refPlaceholders = refs.map((r, i) => { params["r" + i] = r.slice(0, 300); return "@r" + i; });
    const existingRows = await query(
      "SELECT TOP 1 id, status FROM dbo.tickets WHERE conversation_id = @conversationId" +
        (refs.length ? " OR graph_message_id IN (" + refPlaceholders.join(",") + ")" : "") +
        " ORDER BY id DESC",
      params
    );
    const existing = existingRows[0];

    if (existing && existing.status !== "Resolved") {
      const noteText = "Email reply from " + fromName + " <" + fromAddr + ">:\n\n" + (bodyText || "(empty body)");
      await withTx(async (tx) => {
        await query(
          "INSERT INTO dbo.notes (ticket_id, [text], [at], [system]) VALUES (@id, @text, @now, 0)",
          { id: existing.id, text: noteText, now: ts(now) }, tx
        );
        await query("UPDATE dbo.tickets SET updated_at = @now WHERE id = @id", { id: existing.id, now: ts(now) }, tx);
        await query(
          "INSERT INTO dbo.email_ingest_log (graph_message_id, ticket_id, action, processed_at) VALUES (@messageId, @id, N'appended', @now)",
          { messageId, id: existing.id, now: ts(now) }, tx
        );
      });
      return json({ action: "appended", ticketId: existing.id });
    }

    // New ticket. Unique index on graph_message_id backstops dedup.
    const ticketId = await withTx(async (tx) => {
      const rows = await query(
        `INSERT INTO dbo.tickets
           (subject, description, requester, category, priority, status, assignee, created_at, updated_at, source, graph_message_id, conversation_id)
         OUTPUT INSERTED.id
         VALUES (@subject, @bodyText, @fromAddr, N'Other', N'Medium', N'Open', N'Unassigned', @now, @now, N'Email', @messageId, @conversationId)`,
        { subject, bodyText, fromAddr, now: ts(now), messageId, conversationId }, tx
      );
      const id = rows[0].id;
      await query(
        "INSERT INTO dbo.notes (ticket_id, [text], [at], [system]) VALUES (@id, @text, @now, 1)",
        { id, text: "Created from email sent by " + fromName + " <" + fromAddr + ">", now: ts(now) }, tx
      );
      await query(
        "INSERT INTO dbo.email_ingest_log (graph_message_id, ticket_id, action, processed_at) VALUES (@messageId, @id, N'created', @now)",
        { messageId, id, now: ts(now) }, tx
      );
      return id;
    });
    return json({ action: "created", ticketId }, 201);
  }),
});
