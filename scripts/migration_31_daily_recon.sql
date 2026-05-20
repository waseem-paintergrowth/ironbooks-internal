-- ============================================================================
-- Migration 31: Daily reconciliation scaffolding
-- ============================================================================
-- Adds the tables + columns needed for ongoing daily categorization runs.
--
-- NOT WIRED LIVE YET. After applying this migration:
--   - All clients default to daily_recon_enabled=false (worker ignores them)
--   - The cron route exists at /api/cron/daily-recon but is NOT registered
--     in vercel.json, so it never fires automatically
--   - Admins can manually invoke /api/daily-recon/run/[clientId]?dryRun=true
--     for testing on a single client
--
-- To go live (later):
--   1. Set daily_recon_enabled=true on the pilot clients
--   2. Add the cron entry to vercel.json
--   3. Watch /today for a few cycles in dry-run mode before flipping
--      live auto-execute
-- ============================================================================

-- ── client_links: feature flag + sync tracking ───────────────────────────────
ALTER TABLE client_links
  ADD COLUMN IF NOT EXISTS daily_recon_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS daily_recon_paused BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS daily_recon_paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

COMMENT ON COLUMN client_links.daily_recon_enabled IS
  'When true, the daily recon cron processes this client. Default false so the system is opt-in per client.';
COMMENT ON COLUMN client_links.daily_recon_paused IS
  'Per-run cap or hard-block exceeded — bookkeeper must unstick. Set automatically by the worker, cleared from the admin panel.';
COMMENT ON COLUMN client_links.last_synced_at IS
  'Timestamp of the most recent successful daily run. Used by the worker to compute the delta window.';


-- ── daily_recon_runs: one row per cron tick per client ───────────────────────
CREATE TABLE IF NOT EXISTS daily_recon_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Delta scope (inclusive of fetched_from, exclusive of fetched_to)
  fetched_from TIMESTAMPTZ,
  fetched_to   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Stats
  transactions_pulled   INTEGER NOT NULL DEFAULT 0,
  auto_executed         INTEGER NOT NULL DEFAULT 0,
  queued_for_review     INTEGER NOT NULL DEFAULT 0,
  anomalies_count       INTEGER NOT NULL DEFAULT 0,

  duration_ms   INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','complete','failed','dry_run')),
  error_message TEXT,
  dry_run       BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_daily_recon_runs_client
  ON daily_recon_runs(client_link_id, run_at DESC);

COMMENT ON TABLE daily_recon_runs IS
  'Observability log for the daily worker — one row per (client, cron tick). lib/daily-recon.ts writes these.';


-- ── processed_qbo_lines: idempotency guard ───────────────────────────────────
-- Composite PK prevents the same QBO line from being touched twice across
-- runs, regardless of clock skew or overlapping date windows.
CREATE TABLE IF NOT EXISTS processed_qbo_lines (
  client_link_id      UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  qbo_line_id         TEXT NOT NULL,
  qbo_transaction_id  TEXT NOT NULL,
  processed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_id              UUID REFERENCES daily_recon_runs(id) ON DELETE SET NULL,
  auto_executed       BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (client_link_id, qbo_line_id)
);

CREATE INDEX IF NOT EXISTS idx_processed_qbo_lines_run
  ON processed_qbo_lines(run_id);

COMMENT ON TABLE processed_qbo_lines IS
  'Idempotency table — the worker checks (client_link_id, qbo_line_id) before processing. Re-running a window is a no-op.';


-- ── daily_review_queue: per-line items shown on /today ───────────────────────
CREATE TABLE IF NOT EXISTS daily_review_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  run_id         UUID REFERENCES daily_recon_runs(id) ON DELETE SET NULL,

  -- QBO identity
  qbo_transaction_id   TEXT NOT NULL,
  qbo_transaction_type TEXT NOT NULL,
  qbo_line_id          TEXT NOT NULL,
  sync_token           TEXT,

  -- Transaction snapshot
  vendor_name         TEXT,
  transaction_date    DATE,
  transaction_amount  NUMERIC,
  description         TEXT,
  from_account_id     TEXT,
  from_account_name   TEXT,

  -- Suggested categorization
  suggested_account_id    TEXT,
  suggested_account_name  TEXT,
  ai_confidence           NUMERIC,
  ai_reasoning            TEXT,
  source                  TEXT CHECK (source IN ('kb','bank_rule','ai','web_search','unmatched')),

  -- Anomalies detected (array of { code, message })
  anomaly_flags JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Workflow state
  decision     TEXT NOT NULL DEFAULT 'pending'
               CHECK (decision IN ('pending','approved','rejected','ask_client','auto_approved','executed')),
  decided_by   UUID REFERENCES users(id),
  decided_at   TIMESTAMPTZ,
  executed_at  TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: "what does this client have pending?"
CREATE INDEX IF NOT EXISTS idx_daily_queue_client_pending
  ON daily_review_queue(client_link_id, decision)
  WHERE decision = 'pending';

CREATE INDEX IF NOT EXISTS idx_daily_queue_client_created
  ON daily_review_queue(client_link_id, created_at DESC);

COMMENT ON COLUMN daily_review_queue.source IS
  'Which tier produced the suggestion: kb=knowledge base, bank_rule=local cache, ai=Claude direct, web_search=Claude with web access, unmatched=no suggestion';

COMMENT ON TABLE daily_review_queue IS
  'Per-transaction-line items needing bookkeeper review. Drives /today UI. Rows transition pending → approved/rejected → executed.';
