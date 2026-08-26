-- Migration 0002: email-to-ticket support
-- Run with:
--   npx wrangler d1 execute helpdesk --remote --file=./migrations/0002_email_to_ticket.sql
-- (drop --remote to test against your local D1 first)

-- Where the ticket came from: 'Manual' (default) or 'Email'
ALTER TABLE tickets ADD COLUMN source TEXT NOT NULL DEFAULT 'Manual';

-- The Graph message id of the email that created the ticket.
-- UNIQUE index = hard dedup guarantee: even if a poll run crashes after
-- inserting but before marking the mail as read, the retry cannot create
-- a second ticket for the same message.
ALTER TABLE tickets ADD COLUMN graph_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_graph_message_id
  ON tickets (graph_message_id)
  WHERE graph_message_id IS NOT NULL;

-- Graph conversationId for the email thread. Replies to an existing
-- thread get appended to the original ticket as work notes instead of
-- spawning duplicate tickets.
ALTER TABLE tickets ADD COLUMN conversation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tickets_conversation_id
  ON tickets (conversation_id)
  WHERE conversation_id IS NOT NULL;

-- Every processed message id, whether it became a ticket or a note.
-- This is what makes note-appends idempotent too (notes have no natural
-- unique key the way tickets do).
CREATE TABLE IF NOT EXISTS email_ingest_log (
  graph_message_id TEXT PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  action TEXT NOT NULL,          -- 'created' | 'appended'
  processed_at TEXT NOT NULL
);
