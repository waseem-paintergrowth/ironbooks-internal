-- Migration 65: Production board state + full-close trail
-- =========================================================
-- The /production board tracks each (client, month) through four manual
-- columns: not_started / in_progress / stuck / waiting_client, with
-- checkbox reasons when waiting on the client. "Ready for manager review"
-- is NOT a stored reason — it fires the existing submit action
-- (status='pending_review').
--
-- Also adds the manager-approval full-close trail: the QBO closing-date
-- write outcome and the month-end package the approval published.
--
-- Idempotent — safe to run more than once.

ALTER TABLE monthly_rec_runs
  ADD COLUMN IF NOT EXISTS board_status     text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS waiting_reasons  jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS status_note      text,
  ADD COLUMN IF NOT EXISTS qbo_close_error  text,
  ADD COLUMN IF NOT EXISTS month_end_package_id uuid;

ALTER TABLE monthly_rec_runs
  DROP CONSTRAINT IF EXISTS monthly_rec_runs_board_status_check;
ALTER TABLE monthly_rec_runs
  ADD CONSTRAINT monthly_rec_runs_board_status_check
  CHECK (board_status IN ('not_started', 'in_progress', 'stuck', 'waiting_client'));
