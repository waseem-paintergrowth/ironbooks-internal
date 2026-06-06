-- Migration 52: Fleet Health Dashboard — dismissals + indexes
--
-- Context:
--   At ~50 clients Lisa can keep "what's broken" in her head. At
--   500 it's lost time hunting; at 1,000 silent failures rot in
--   production. The Fleet Health Dashboard surfaces every failed /
--   stuck / drifting client in one screen. Read-only v1 (Week 1)
--   just queries existing tables — no schema dependencies for the
--   panels themselves.
--
--   This migration adds ONLY the table needed for snooze/dismiss
--   behavior (the rest of the dashboard is pure aggregation).
--
-- Safe to re-run: IF NOT EXISTS guards everywhere.

CREATE TABLE IF NOT EXISTS fleet_dismissals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The kind of fleet item being dismissed. Free text so future panels
  -- can add categories without a schema bump; the dashboard validates
  -- against its known set at read time.
  item_type   TEXT NOT NULL,
  -- Polymorphic id — depending on item_type this might be a
  -- reclass_jobs.id, a coa_jobs.id, a client_links.id, etc.
  item_id     TEXT NOT NULL,
  -- Optional client scope so per-client dismissals don't suppress
  -- the same issue type on a different client.
  client_link_id UUID REFERENCES client_links(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  reason      TEXT,
  -- When the dismissal expires and the item re-surfaces on the
  -- dashboard. NULL = never expires (mark won't-fix).
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fleet_dismissals_item_idx
  ON fleet_dismissals (item_type, item_id);
CREATE INDEX IF NOT EXISTS fleet_dismissals_client_idx
  ON fleet_dismissals (client_link_id, expires_at);
-- (No partial index on (expires_at IS NULL OR expires_at > now()) —
-- now() is STABLE not IMMUTABLE and Postgres refuses it in index
-- predicates. The two indexes above are enough; the dashboard's
-- read path filters by expires_at at query time, which uses the
-- existing fleet_dismissals_item_idx for the seek + a small in-mem
-- filter for the time check. Table is expected to stay <10K rows.)

SELECT 'migration_52 applied' AS status;
