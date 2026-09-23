# MESHELPDESK API — Azure Functions (Static Web Apps managed API)

Port of `worker.js` to Azure Functions (Node 20, v4 model) on Azure SQL.
Same routes and JSON shapes as the Worker, so `public/index.html` is unchanged.

| Worker route | Function file |
|---|---|
| GET /api/state | src/functions/state.js |
| POST /api/tickets, PATCH/DELETE /api/tickets/:id, POST /api/tickets/:id/notes | src/functions/tickets.js |
| POST /api/technicians, DELETE /api/technicians/:name | src/functions/technicians.js |
| GET/PUT /api/prefs/tabs | src/functions/prefs.js |
| POST /api/triage | src/functions/triage.js |
| `email` handler (Email Routing) | src/functions/emailInbound.js (POST /api/email/inbound, called by a Logic App) |

## App settings
- `SQL_CONNECTION_STRING` (required) — SQL auth to a least-privilege DB user
- `EMAIL_INGEST_KEY` — shared secret for /api/email/inbound; endpoint returns 501 until set
- `ANTHROPIC_API_KEY` — optional, enables AI triage

Local: copy `local.settings.json.example` to `local.settings.json` (git-ignored),
fill it in, then from the repo root run `swa start public --api-location api`.
