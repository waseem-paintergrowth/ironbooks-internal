-- Migration 56: store per-module discovery notes (e.g. A/R aging-summary tie-out)
--
-- The Accounts Receivable module can now recognize an uploaded QuickBooks
-- "A/R Aging Summary" report. That report has no invoice-level rows, so it
-- can't drive matching — instead we reconcile its per-customer totals against
-- the live QBO open-invoice balances and store the result here so the review
-- UI can render an informational tie-out banner.

ALTER TABLE cleanup_run_modules
  ADD COLUMN IF NOT EXISTS discovery_notes JSONB;

COMMENT ON COLUMN cleanup_run_modules.discovery_notes IS
  'Optional structured discovery output that is not a proposed entry — e.g. A/R aging-summary reconciliation tie-out. Rendered as an info banner in the review UI.';
