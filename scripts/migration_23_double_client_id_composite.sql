-- Migration 23: allow one Double client to map to multiple QBO realms
--
-- Baldwin & Co. Painting and Finishing has TWO QBO companies under
-- ONE Double client record — sole prop + Canadian corp. The original
-- UNIQUE(double_client_id) constraint assumed a strict 1:1 mapping
-- and breaks for clients with multiple legal entities sharing one
-- Double profile.
--
-- Fix: swap to a composite unique on (double_client_id, qbo_realm_id).
-- That still prevents true duplicate links (same Double client +
-- same QBO realm linked twice), but allows one Double client to
-- have N distinct QBO connections.
--
-- Idempotent. Safe to run on environments that already swapped
-- (the DROP / ADD guards both check existence).

-- 1. Drop the legacy single-column constraint if present.
ALTER TABLE client_links
  DROP CONSTRAINT IF EXISTS client_links_double_client_id_key;

-- 2. Add the composite unique if not already present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'client_links_double_qbo_unique'
  ) THEN
    ALTER TABLE client_links
      ADD CONSTRAINT client_links_double_qbo_unique
      UNIQUE (double_client_id, qbo_realm_id);
  END IF;
END $$;

-- Verify
SELECT
  conname AS constraint_name,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'client_links'::regclass
  AND contype = 'u'
ORDER BY conname;
