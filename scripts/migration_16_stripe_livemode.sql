-- Migration 16: track whether the Stripe Connect token is live or test mode.
--
-- The OAuth response includes a `livemode` boolean. Without saving it, we
-- can't tell a sandbox connection from a real one — and a bookkeeper running
-- recon on real cleanup data with a sandbox connection silently sees zero
-- payouts.
--
-- We save it once at OAuth callback time. The recon path warns on mismatch
-- between the connection mode and the env (production vs test).

ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS stripe_livemode boolean;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'client_links' AND column_name = 'stripe_livemode';
