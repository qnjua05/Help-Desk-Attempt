// Ticket Desk — Cloudflare Worker with D1 backend
//
// Routes:
//   GET    /api/state                 -> { tickets, technicians }
//   POST   /api/tickets               -> create ticket
//   PATCH  /api/tickets/:id           -> update fields (server writes audit notes)
//   DELETE /api/tickets/:id           -> delete ticket + its notes
//   POST   /api/tickets/:id/notes     -> add a manual work note
//   POST   /api/technicians           -> add engineer { name }
//   DELETE /api/technicians/:name     -> remove engineer
//   POST   /api/triage                -> AI triage (requires ANTHROPIC_API_KEY secret)
//   everything else                   -> static assets from public/
//
// The frontend is served by this same worker, so no CORS setup is needed.

const CATEGORIES = ["Hardware", "Software", "Network", "Accounts & Access", "Email / M365", "Printing", "Other"];
const PRIORITIES = ["Critical", "High", "Medium", "Low"];
const STATUSES = ["Open", "In Progress", "On Hold", "Resolved"];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const ticketKey = (n) => "TKT-" + String(n).padStart(4, "0");

function rowToTicket(row, notes) {
  return {
    id: row.id,
    key: ticketKey(row.id),
    subject: row.subject,
    description: row.description || "",
    requester: row.requester || "",
    category: row.category,
    priority: row.priority,
    status: row.status,
    assignee: row.assignee,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at || null,
    notes: notes || [],
  };
}

async function getTicket(env, id) {
  const row = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first();
  if (!row) return null;
  const notesRes = await env.DB.prepare(
    "SELECT text, at, system FROM notes WHERE ticket_id = ? ORDER BY id"
  ).bind(id).all();
  const notes = (notesRes.results || []).map((n) => ({
    text: n.text,
    at: n.at,
    system: !!n.system,
  }));
  return rowToTicket(row, notes);
}

async function listTechnicians(env) {
  const res = await env.DB.prepare("SELECT name FROM technicians ORDER BY name").all();
  return (res.results || []).map((r) => r.name);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path.startsWith("/api/")) {
        // ---------- full state (tickets + technicians) ----------
        if (path === "/api/state" && method === "GET") {
          const tRes = await env.DB.prepare("SELECT * FROM tickets ORDER BY id DESC").all();
          const nRes = await env.DB.prepare(
            "SELECT ticket_id, text, at, system FROM notes ORDER BY id"
          ).all();
          const byTicket = {};
          for (const n of nRes.results || []) {
            (byTicket[n.ticket_id] = byTicket[n.ticket_id] || []).push({
              text: n.text,
              at: n.at,
              system: !!n.system,
            });
          }
          const tickets = (tRes.results || []).map((r) => rowToTicket(r, byTicket[r.id]));
          return json({ tickets, technicians: await listTechnicians(env) });
        }

        // ---------- create ticket ----------
        if (path === "/api/tickets" && method === "POST") {
          const b = await request.json();
          if (!b.subject || !String(b.subject).trim()) {
            return json({ error: "Subject is required" }, 400);
          }
          const now = new Date().toISOString();
          const res = await env.DB.prepare(
            "INSERT INTO tickets (subject, description, requester, category, priority, status, assignee, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'Open', 'Unassigned', ?, ?)"
          ).bind(
            String(b.subject).trim(),
            String(b.description || "").trim(),
            String(b.requester || "").trim(),
            CATEGORIES.includes(b.category) ? b.category : "Other",
            PRIORITIES.includes(b.priority) ? b.priority : "Medium",
            now,
            now
          ).run();
          const id = res.meta.last_row_id;
          return json(await getTicket(env, id), 201);
        }

        // ---------- per-ticket routes ----------
        const ticketMatch = path.match(/^\/api\/tickets\/(\d+)(\/notes)?$/);
        if (ticketMatch) {
          const id = Number(ticketMatch[1]);
          const isNotes = !!ticketMatch[2];

          // add manual work note
          if (isNotes && method === "POST") {
            const b = await request.json();
            if (!b.text || !String(b.text).trim()) {
              return json({ error: "Note text is required" }, 400);
            }
            const exists = await env.DB.prepare("SELECT id FROM tickets WHERE id = ?").bind(id).first();
            if (!exists) return json({ error: "Ticket not found" }, 404);
            const now = new Date().toISOString();
            await env.DB.prepare(
              "INSERT INTO notes (ticket_id, text, at, system) VALUES (?, ?, ?, 0)"
            ).bind(id, String(b.text).trim(), now).run();
            await env.DB.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").bind(now, id).run();
            return json(await getTicket(env, id));
          }

          // update fields with automatic audit trail
          if (!isNotes && method === "PATCH") {
            const b = await request.json();
            const current = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first();
            if (!current) return json({ error: "Ticket not found" }, 404);
            const now = new Date().toISOString();

            const allowedValues = {
              status: STATUSES,
              assignee: null, // any name allowed; UI restricts to roster
              priority: PRIORITIES,
              category: CATEGORIES,
            };
            const updates = {};
            const changes = [];
            for (const f of Object.keys(allowedValues)) {
              if (b[f] !== undefined && b[f] !== current[f]) {
                const allowed = allowedValues[f];
                if (allowed && !allowed.includes(b[f])) {
                  return json({ error: "Invalid value for " + f }, 400);
                }
                updates[f] = b[f];
                changes.push(
                  f.charAt(0).toUpperCase() + f.slice(1) + ": " + current[f] + " → " + b[f]
                );
              }
            }

            let resolvedAt = current.resolved_at || null;
            if (updates.status === "Resolved" && current.status !== "Resolved") resolvedAt = now;
            if (updates.status && updates.status !== "Resolved") resolvedAt = null;

            if (Object.keys(updates).length) {
              const setClauses = Object.keys(updates).map((f) => f + " = ?");
              const values = Object.values(updates);
              await env.DB.prepare(
                "UPDATE tickets SET " + setClauses.join(", ") + ", resolved_at = ?, updated_at = ? WHERE id = ?"
              ).bind(...values, resolvedAt, now, id).run();
              await env.DB.prepare(
                "INSERT INTO notes (ticket_id, text, at, system) VALUES (?, ?, ?, 1)"
              ).bind(id, changes.join(" · "), now).run();
            }
            return json(await getTicket(env, id));
          }

          // delete ticket
          if (!isNotes && method === "DELETE") {
            await env.DB.prepare("DELETE FROM notes WHERE ticket_id = ?").bind(id).run();
            await env.DB.prepare("DELETE FROM tickets WHERE id = ?").bind(id).run();
            return json({ ok: true });
          }
        }

        // ---------- technicians ----------
        if (path === "/api/technicians" && method === "POST") {
          const b = await request.json();
          const name = String(b.name || "").trim();
          if (!name || name === "Unassigned") return json({ error: "Invalid name" }, 400);
          await env.DB.prepare("INSERT OR IGNORE INTO technicians (name) VALUES (?)").bind(name).run();
          return json({ technicians: await listTechnicians(env) });
        }
        const techMatch = path.match(/^\/api\/technicians\/(.+)$/);
        if (techMatch && method === "DELETE") {
          const name = decodeURIComponent(techMatch[1]);
          await env.DB.prepare("DELETE FROM technicians WHERE name = ?").bind(name).run();
          return json({ technicians: await listTechnicians(env) });
        }

        // ---------- AI triage ----------
        if (path === "/api/triage" && method === "POST") {
          if (!env.ANTHROPIC_API_KEY) {
            return json(
              { error: "AI triage isn't configured yet — add the ANTHROPIC_API_KEY secret (see SETUP.md)." },
              501
            );
          }
          const t = await request.json();
          const prompt =
            "You are an IT helpdesk triage assistant. Analyze this ticket and respond with ONLY a raw JSON object, no markdown fences, no preamble. Keys: " +
            '"category" (exactly one of ' + JSON.stringify(CATEGORIES) + "), " +
            '"priority" (exactly one of ' + JSON.stringify(PRIORITIES) + "), " +
            '"reasoning" (one short sentence), ' +
            '"firstResponse" (a professional 2-4 sentence first reply to the requester).' +
            "\n\nSubject: " + (t.subject || "") +
            "\nDescription: " + (t.description || "(none)") +
            "\nCurrent category: " + (t.category || "") +
            "\nCurrent priority: " + (t.priority || "");
          const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": env.ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-6",
              max_tokens: 1000,
              messages: [{ role: "user", content: prompt }],
            }),
          });
          const data = await r.json();
          const text = (data.content || [])
            .filter((blk) => blk.type === "text")
            .map((blk) => blk.text)
            .join("\n");
          try {
            return json(JSON.parse(text.replace(/```json|```/g, "").trim()));
          } catch (e) {
            return json({ error: "Triage returned an unexpected format — try again." }, 502);
          }
        }

        return json({ error: "Not found" }, 404);
      }

      // ---------- static frontend ----------
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: "Server error: " + (err && err.message ? err.message : "unknown") }, 500);
    }
  },
};
