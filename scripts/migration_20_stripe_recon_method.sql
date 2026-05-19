-- Migration 20: track which matching method each Stripe recon used
--
-- When a client connects Stripe after a QBO-AI-match recon was already
-- run, we want to surface an obvious "upgrade with Stripe API" path on
-- the prior job's review page. To do that we need to know which method
-- each historical job used — wasn't stored before.
--
-- Existing rows are backfilled to 'qbo_invoice_match' because that's
-- the default the form falls back to when Stripe isn't connected, and
-- it's also the safer assumption (if it was the Stripe API path the
-- upgrade banner just won't fire, which is harmless).
--
-- Idempotent.

ALTER TABLE stripe_recon_jobs
  ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'qbo_invoice_match';

-- Verify
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'stripe_recon_jobs'
  AND column_name = 'method';
