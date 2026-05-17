-- Migration 15: stripe_recon_matches.candidate_invoices for manual matching
--
-- The AI matcher can fail to identify invoices for various reasons (deposits
-- that mix multiple clients, batch settlements, irregular fee patterns). Today
-- those rows just sit in Flagged with no path forward except sending the link.
--
-- We now save the full candidate pool (±30-day window of QBO invoices &
-- customer payments) on each match row, so the review UI can render a
-- checkbox picker — the bookkeeper completes the recon manually without
-- bouncing back to QBO.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE stripe_recon_matches
  ADD COLUMN IF NOT EXISTS candidate_invoices jsonb;

ALTER TABLE stripe_recon_matches
  ADD COLUMN IF NOT EXISTS candidate_payments jsonb;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'stripe_recon_matches'
  AND column_name IN ('candidate_invoices', 'candidate_payments');
