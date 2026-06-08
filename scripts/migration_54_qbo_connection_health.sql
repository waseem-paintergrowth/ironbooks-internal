-- Migration 54: persisted QBO connection health
--
-- Context:
--   qbo_refresh_log (migration 53) records every refresh attempt with
--   source / result / duration. Useful for forensics but unwieldy for
--   "what's the current state of each client?" lookups — that's a
--   recent-row-per-client window query every time.
--
--   This table denormalizes: one row per client_link_id with the latest
--   probe status. /api/fleet/qbo-health-check writes here on every run;
--   the new /fleet/qbo-health page reads from here for fast renders.
--
-- Safe to re-run: IF NOT EXISTS guards.

CREATE TABLE IF NOT EXISTS qbo_connection_health (
  client_link_id   UUID PRIMARY KEY REFERENCES client_links(id) ON DELETE CASCADE,
  -- Three possible states the dashboard cares about:
  --   ok              → last probe succeeded; refresh is alive
  --   invalid_grant   → refresh token dead; needs re-auth
  --   other_error     → transient (network, QBO 5xx, etc) — re-probe before action
  --   never_connected → client has no qbo_realm_id at all
  status           TEXT NOT NULL,
  last_checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_message    TEXT,
  -- Most recent successful refresh. Rolled forward when status=ok.
  -- NULL means "never seen a successful refresh in the lifetime of
  -- this health record." Useful for "client onboarded but token died
  -- on first use" detection.
  last_ok_at       TIMESTAMPTZ,
  -- When the current failure streak started. NULL while status=ok.
  -- Bookkeeper sees "Dead for 7 days" instead of "expired at <some date>".
  first_failed_at  TIMESTAMPTZ,
  -- When the bookkeeper acknowledged the issue (clicked Reconnect or
  -- marked it being-worked-on). Lets the dashboard show "5 dead, 2 in
  -- progress" rather than treating acknowledged + unacknowledged the same.
  reconnect_initiated_at TIMESTAMPTZ,
  reconnect_initiated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qbo_connection_health_status_idx
  ON qbo_connection_health (status, last_checked_at DESC);
CREATE INDEX IF NOT EXISTS qbo_connection_health_dead_idx
  ON qbo_connection_health (first_failed_at)
  WHERE status IN ('invalid_grant', 'other_error');

SELECT 'migration_54 applied' AS status;
