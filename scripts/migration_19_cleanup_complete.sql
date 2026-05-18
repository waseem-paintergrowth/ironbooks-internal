-- Migration 19: per-client cleanup completion state
--
-- After a bookkeeper finishes the COA → reclass → stripe-recon loop, they
-- need a way to mark the whole client "done for this cycle" so the row
-- moves out of the active work queue. Completed accounts should still be
-- reachable (re-pull the PDF report; reopen if needed), just not in the
-- bookkeeper's day-to-day list.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS cleanup_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cleanup_completed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cleanup_completion_note text,
  -- Date range covered by the just-finished cleanup. Saved so the PDF
  -- report button on the Completed Accounts table can fire without asking
  -- the bookkeeper to re-pick dates.
  ADD COLUMN IF NOT EXISTS cleanup_range_start date,
  ADD COLUMN IF NOT EXISTS cleanup_range_end date;

-- Index for the "active vs completed" partition on the clients page.
-- Most-completed-first ordering on the completed section.
CREATE INDEX IF NOT EXISTS idx_client_links_cleanup_completed_at
  ON client_links (cleanup_completed_at DESC NULLS LAST);

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'client_links'
  AND column_name IN (
    'cleanup_completed_at',
    'cleanup_completed_by',
    'cleanup_completion_note',
    'cleanup_range_start',
    'cleanup_range_end'
  )
ORDER BY column_name;
