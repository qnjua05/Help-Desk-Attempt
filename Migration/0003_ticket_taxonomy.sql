-- Migration 0003: ticket taxonomy
-- Adds Request type and Sub category to tickets.
--
-- request_type: Incident | Service Request | Question | Change
--   Existing tickets default to 'Incident' (safest assumption for a helpdesk queue).
-- sub_category: free text validated by the UI, dependent on category.
--   Existing tickets default to '' and display as "—" until triaged.
--
-- Run with:
--   npx wrangler d1 execute helpdesk --remote --file=Migration/0003_ticket_taxonomy.sql

ALTER TABLE tickets ADD COLUMN request_type TEXT NOT NULL DEFAULT 'Incident';
ALTER TABLE tickets ADD COLUMN sub_category TEXT NOT NULL DEFAULT '';
