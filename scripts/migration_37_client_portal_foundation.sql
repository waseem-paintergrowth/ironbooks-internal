-- ============================================================================
-- Migration 37: Client Portal Foundation
-- ============================================================================
-- Adds the auth + linkage primitives for the client-facing portal:
--
--   1. New `client` value on the user_role enum — distinct from
--      admin/lead/bookkeeper/viewer (all internal-staff roles)
--   2. `client_users` link table — maps a portal user to the client_link
--      they have visibility into (one user → one client; the same client
--      can have multiple portal users for owner + spouse + sales lead, etc.)
--   3. RLS-friendly view + helper function for "is this user a client of
--      this client_link?" — used by portal-side data queries
--
-- After this migration, internal SNAP users continue to work unchanged.
-- Portal users (role='client') are blocked from any non-portal route by
-- middleware in app code.
--
-- NOTE: this migration only adds *structures*. Wiring the login router
-- + invitation flow + RLS policies on individual data tables is done in
-- follow-up commits/migrations as each portal feature lands.
-- ============================================================================

-- 1. Add the new enum value. Postgres requires enum extensions outside
--    a transaction in some setups — using IF NOT EXISTS guard.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'client'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'user_role')
  ) THEN
    ALTER TYPE user_role ADD VALUE 'client';
  END IF;
END
$$;


-- 2. Linkage table — portal user → which client they can see.
--    UNIQUE on user_id keeps it one-client-per-user. If a real-world
--    scenario needs cross-client portal users (a parent company owner
--    seeing multiple subs), we'd relax this later.
CREATE TABLE IF NOT EXISTS client_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  -- Who at Ironbooks granted this portal access (audit trail). Nullable for
  -- self-signup flows that don't pass through admin invite.
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_login_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  -- Soft-disable without deleting (and losing chat history when we add it).
  -- Active=false hides the client_link from the portal user but keeps the row.
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_users_user
  ON client_users(user_id);
CREATE INDEX IF NOT EXISTS idx_client_users_client
  ON client_users(client_link_id);

COMMENT ON TABLE client_users IS
  'Maps portal users (users.role=client) to the client_link they can see in the portal. One row per (user, client) pairing. Internal staff (admin/lead/bookkeeper) are NOT in this table — their visibility comes from the assigned_bookkeeper_id on client_links plus role-based access.';


-- 3. Helper function — "can this user_id see this client_link?". Used by
--    RLS policies on data tables as portal features come online. Defined
--    as STABLE so PG can cache the result inside a single query.
CREATE OR REPLACE FUNCTION user_can_see_client(p_user_id UUID, p_client_link_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    -- Portal user with an explicit mapping
    SELECT 1 FROM client_users
    WHERE user_id = p_user_id
      AND client_link_id = p_client_link_id
      AND active = TRUE
  ) OR EXISTS (
    -- Internal staff — any non-client role can see any client_link
    SELECT 1 FROM users
    WHERE id = p_user_id
      AND role IN ('admin', 'lead', 'bookkeeper', 'viewer')
      AND is_active = TRUE
  );
$$;

COMMENT ON FUNCTION user_can_see_client IS
  'Single source of truth for "can this user see this client_link?". Used by RLS policies on client-facing data tables.';
