-- ============================================================
-- MESHELPDESK — Azure SQL (Migration/azure/0002)
-- Adds tickets.resolved_at, which worker.js / the API read and
-- write but which was missing from 0001_azure_baseline.sql.
-- Idempotent: safe to re-run.
-- ============================================================
IF COL_LENGTH(N'dbo.tickets', N'resolved_at') IS NULL
BEGIN
    ALTER TABLE dbo.tickets ADD resolved_at DATETIME2(3) NULL;
END;
GO
