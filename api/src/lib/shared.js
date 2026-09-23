// Shared helpers ported from worker.js — constants, row mapping, identity.

const { query } = require("./db");

const CATEGORIES = ["Hardware", "Software", "Network", "Accounts & Access", "Email / M365", "Printing", "Other"];
const PRIORITIES = ["Critical", "High", "Medium", "Low"];
const STATUSES = ["Open", "In Progress", "On Hold", "In Development", "In QA", "UAT", "Ready for Deployment", "Resolved"];
const REQUEST_TYPES = ["Incident", "Service Request", "Question", "Change"];

// Functions v4 response shape. Same JSON bodies the Worker returned,
// so public/index.html needs no changes.
const json = (data, status = 200) => ({ status, jsonBody: data });

const ticketKey = (n) => "TKT-" + String(n).padStart(4, "0");

// DATETIME2 columns come back as JS Dates; toISOString() keeps the exact
// string format the frontend already receives from D1.
const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

function rowToTicket(row, notes) {
  return {
    id: row.id,
    key: ticketKey(row.id),
    subject: row.subject,
    description: row.description || "",
    requester: row.requester || "",
    category: row.category,
    subCategory: row.sub_category || "",
    requestType: row.request_type || "Incident",
    priority: row.priority,
    status: row.status,
    assignee: row.assignee,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    resolvedAt: iso(row.resolved_at),
    source: row.source || "Manual",
    notes: notes || [],
  };
}

const noteOut = (n) => ({ text: n.text, at: iso(n.at), system: !!n.system });

async function getTicket(id, tx) {
  const rows = await query("SELECT * FROM dbo.tickets WHERE id = @id", { id }, tx);
  if (!rows.length) return null;
  const notes = await query(
    "SELECT [text], [at], [system] FROM dbo.notes WHERE ticket_id = @id ORDER BY id",
    { id },
    tx
  );
  return rowToTicket(rows[0], notes.map(noteOut));
}

async function listTechnicians() {
  const rows = await query("SELECT name FROM dbo.technicians ORDER BY name");
  return rows.map((r) => r.name);
}

// Signed-in user from Static Web Apps auth. SWA forwards the principal to
// the API as a base64 JSON header; userDetails is the Entra UPN / email.
// Replaces the Cf-Access-Authenticated-User-Email header.
function getUserEmail(request) {
  const header = request.headers.get("x-ms-client-principal");
  if (!header) return "local-dev";
  try {
    const p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return p.userDetails || "local-dev";
  } catch {
    return "local-dev";
  }
}

async function readJson(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}

// Wrap a handler so any thrown error returns the same 500 shape the Worker used.
const handle = (fn) => async (request, context) => {
  try {
    return await fn(request, context);
  } catch (err) {
    context.error(err);
    return json({ error: "Server error: " + (err && err.message ? err.message : "unknown") }, 500);
  }
};

module.exports = {
  CATEGORIES, PRIORITIES, STATUSES, REQUEST_TYPES,
  json, iso, rowToTicket, noteOut, getTicket, listTechnicians, getUserEmail, readJson, handle,
};
