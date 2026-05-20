-- Migration 27: per-client "doesn't use Stripe" flag
--
-- Today every QBO-connected client gets nagged about Stripe everywhere:
--   - Pending Stripe Invites widget on the dashboard
--   - "Send Stripe Connect link" prompts on the unmatched-recon panel
--   - The Stripe row on the comms-tracker (always shown)
--   - The kanban "Awaiting Stripe" column
--   - The Bank Rules → Stripe Recon handoff
--
-- For clients we know cash-only / use a different processor, all of
-- this is noise. This migration adds a one-bookkeeper-flip switch
-- that suppresses every Stripe prompt for the client.
--
-- Reversible: clearing the flag puts them back into the normal Stripe
-- pipeline. The detector will pick them up again on the next scan
-- if they actually have Stripe-tagged deposits.
--
-- Idempotent.

ALTER TABLE client_links
  -- True = bookkeeper has confirmed this client doesn't use Stripe.
  -- Defaults false so existing clients keep their current behavior.
  ADD COLUMN IF NOT EXISTS stripe_not_required boolean NOT NULL DEFAULT false,
  -- When the flag was set, by whom, and why. Useful audit so we know
  -- "Joe confirmed Lionetti is cash-only on May 20" vs an accidental
  -- click.
  ADD COLUMN IF NOT EXISTS stripe_not_required_at timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_not_required_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stripe_not_required_reason text;

-- Index for the most-common filter ("show me clients who DO need Stripe").
CREATE INDEX IF NOT EXISTS idx_client_links_stripe_not_required
  ON client_links (stripe_not_required);

-- Verify
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'client_links'
  AND column_name LIKE 'stripe_not_required%'
ORDER BY column_name;
