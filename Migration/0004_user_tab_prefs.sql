-- 0004: Per-engineer status tab layout (order + visibility).
-- Keyed by Cloudflare Access identity (Cf-Access-Authenticated-User-Email).
-- tabs_json example:
--   [{"key":"Open","on":true},{"key":"In Progress","on":true}, ... ,{"key":"Overdue","on":false}]
CREATE TABLE IF NOT EXISTS user_tab_prefs (
  user_email TEXT PRIMARY KEY,
  tabs_json  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
