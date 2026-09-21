-- ============================================================
-- MESHELPDESK — Azure SQL baseline (Migration/azure/0001)
-- Consolidates the current D1 end-state (base schema + 0002–0004)
-- into one T-SQL script. Idempotent: safe to re-run.
--
-- Run against the Azure SQL DB via:
--   Portal  : SQL database > Query editor (preview)  — paste & Run
--   Terminal: sqlcmd -S <server>.database.windows.net -d helpdesk \
--             -G -i 0001_azure_baseline.sql        (-G = Entra auth)
--
-- Verify the reconstructed base schema matches production D1 first:
--   npx wrangler d1 execute helpdesk --remote \
--     --command="SELECT sql FROM sqlite_master WHERE type IN ('table','index')"
-- ============================================================

------------------------------------------------------------
-- tickets
-- SQLite INTEGER PRIMARY KEY  -> INT IDENTITY(1,1)
-- TEXT                        -> NVARCHAR (sized) / NVARCHAR(MAX)
-- ISO-8601 text timestamps    -> DATETIME2(3)
--   (new Date().toISOString() strings insert cleanly; the trailing
--    'Z' is parsed and the value is stored as the UTC wall time)
------------------------------------------------------------
IF OBJECT_ID(N'dbo.tickets', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.tickets (
        id                INT IDENTITY(1,1) NOT NULL
                              CONSTRAINT PK_tickets PRIMARY KEY,
        subject           NVARCHAR(500)  NOT NULL,
        description       NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_tickets_description DEFAULT N'',
        requester         NVARCHAR(320)  NOT NULL CONSTRAINT DF_tickets_requester   DEFAULT N'',
        category          NVARCHAR(100)  NOT NULL CONSTRAINT DF_tickets_category    DEFAULT N'',
        -- 0003: taxonomy
        request_type      NVARCHAR(50)   NOT NULL CONSTRAINT DF_tickets_reqtype     DEFAULT N'Incident',
        sub_category      NVARCHAR(100)  NOT NULL CONSTRAINT DF_tickets_subcat      DEFAULT N'',
        priority          NVARCHAR(20)   NOT NULL CONSTRAINT DF_tickets_priority    DEFAULT N'Medium',
        status            NVARCHAR(40)   NOT NULL CONSTRAINT DF_tickets_status      DEFAULT N'Open',
        assignee          NVARCHAR(200)  NOT NULL CONSTRAINT DF_tickets_assignee    DEFAULT N'Unassigned',
        created_at        DATETIME2(3)   NOT NULL CONSTRAINT DF_tickets_created     DEFAULT SYSUTCDATETIME(),
        updated_at        DATETIME2(3)   NOT NULL CONSTRAINT DF_tickets_updated     DEFAULT SYSUTCDATETIME(),
        -- 0002: email-to-ticket
        source            NVARCHAR(20)   NOT NULL CONSTRAINT DF_tickets_source      DEFAULT N'Manual',
        graph_message_id  NVARCHAR(300)  NULL,
        conversation_id   NVARCHAR(300)  NULL
    );
END;
GO

-- 0002: hard dedup on the ingest message id.
-- T-SQL supports filtered indexes, so this ports verbatim in spirit.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'idx_tickets_graph_message_id'
                 AND object_id = OBJECT_ID(N'dbo.tickets'))
BEGIN
    CREATE UNIQUE INDEX idx_tickets_graph_message_id
        ON dbo.tickets (graph_message_id)
        WHERE graph_message_id IS NOT NULL;
END;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'idx_tickets_conversation_id'
                 AND object_id = OBJECT_ID(N'dbo.tickets'))
BEGIN
    CREATE INDEX idx_tickets_conversation_id
        ON dbo.tickets (conversation_id)
        WHERE conversation_id IS NOT NULL;
END;
GO

------------------------------------------------------------
-- notes  (work notes / replies timeline)
-- 'system' flag: SQLite 0/1 INTEGER -> BIT
-- Column names [text] and [at] are kept for zero code churn but
-- bracketed — both collide with T-SQL keywords in some contexts.
------------------------------------------------------------
IF OBJECT_ID(N'dbo.notes', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.notes (
        id         INT IDENTITY(1,1) NOT NULL
                       CONSTRAINT PK_notes PRIMARY KEY,
        ticket_id  INT           NOT NULL
                       CONSTRAINT FK_notes_tickets
                       REFERENCES dbo.tickets(id) ON DELETE CASCADE,
        [text]     NVARCHAR(MAX) NOT NULL,
        [at]       DATETIME2(3)  NOT NULL CONSTRAINT DF_notes_at DEFAULT SYSUTCDATETIME(),
        [system]   BIT           NOT NULL CONSTRAINT DF_notes_system DEFAULT 0
    );

    CREATE INDEX idx_notes_ticket_id ON dbo.notes (ticket_id);
END;
GO

------------------------------------------------------------
-- technicians
------------------------------------------------------------
IF OBJECT_ID(N'dbo.technicians', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.technicians (
        name NVARCHAR(200) NOT NULL
             CONSTRAINT PK_technicians PRIMARY KEY
    );
END;
GO

------------------------------------------------------------
-- email_ingest_log  (0002 — idempotent note-appends)
------------------------------------------------------------
IF OBJECT_ID(N'dbo.email_ingest_log', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.email_ingest_log (
        graph_message_id NVARCHAR(300) NOT NULL
                             CONSTRAINT PK_email_ingest_log PRIMARY KEY,
        ticket_id        INT           NOT NULL,
        action           NVARCHAR(20)  NOT NULL,  -- 'created' | 'appended'
        processed_at     DATETIME2(3)  NOT NULL
    );
END;
GO

------------------------------------------------------------
-- user_tab_prefs  (0004 — per-engineer status tab layout)
-- NOTE: key changes meaning on Azure. On Cloudflare this held the
-- Cf-Access-Authenticated-User-Email; on Azure populate it from the
-- Easy Auth principal (x-ms-client-principal-name / Entra UPN).
-- Same shape, different source — handled in the worker port, not here.
------------------------------------------------------------
IF OBJECT_ID(N'dbo.user_tab_prefs', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.user_tab_prefs (
        user_email NVARCHAR(320) NOT NULL
                       CONSTRAINT PK_user_tab_prefs PRIMARY KEY,
        tabs_json  NVARCHAR(MAX) NOT NULL,
        updated_at DATETIME2(3)  NOT NULL
    );
END;
GO
