-- ============================================================================
-- Migration 44: Unified CRM-Driven Cleanup (V1) — additive schema
-- ============================================================================
-- Extends Migration 41's hardcore_cleanup_* schema to support the 4-bucket
-- workflow Mike specced:
--   1. duplicate_invoice    — CRM-caused dup A/R (existing, kept as-is)
--   2. missing_invoice      — CRM job complete, no matching QBO invoice
--   3. uf_match             — CRM job ↔ UF deposit reconciled (1:1 or 1:N)
--   4. unmatched_job        — CRM job complete, no UF deposit found
--   5. unmatched_uf         — UF deposit, no matching CRM job (ask client)
--
-- DESIGN: 100% additive. Clean Cut Painters' in-flight v1 run (a5a9fd08) MUST
-- keep working in the existing UI/finalize path. We tag new runs as
-- workflow_version=2 so the UI can branch on it; v1 runs render with the
-- legacy code path until they're finalized.
--
-- CHECK constraints can't be altered in Postgres — we DROP + recreate with
-- the wider value set. Safe because the runs/items tables are append-only
-- in practice and the new values don't collide with existing data.
-- ============================================================================

-- ─── hardcore_cleanup_runs: add workflow_version ────────────────────────────
ALTER TABLE hardcore_cleanup_runs
  ADD COLUMN IF NOT EXISTS workflow_version SMALLINT NOT NULL DEFAULT 1;

COMMENT ON COLUMN hardcore_cleanup_runs.workflow_version IS
  'V1 = original duplicate-A/R-only workflow (Migration 41). V2 = unified 4-bucket workflow (Migration 44). UI + finalize branch on this so legacy runs keep working during the rollout.';

CREATE INDEX IF NOT EXISTS idx_hc_cleanup_runs_workflow
  ON hardcore_cleanup_runs(client_link_id, workflow_version, status, created_at DESC);

-- ─── hardcore_cleanup_items: widen item_type CHECK ──────────────────────────
-- Drop the old constraint by name (defined in migration 41). If the name
-- isn't what we expect, fall through gracefully.
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'hardcore_cleanup_items'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%duplicate_invoice%'
  LIMIT 1;
  IF c_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE hardcore_cleanup_items DROP CONSTRAINT ' || quote_ident(c_name);
  END IF;
END $$;

ALTER TABLE hardcore_cleanup_items
  ADD CONSTRAINT hardcore_cleanup_items_item_type_check
  CHECK (item_type IN (
    -- v1 (Migration 41)
    'duplicate_invoice',
    'orphan_uf_payment',
    'stale_ar',
    'unmatched_payment',
    -- v2 (Migration 44 — unified workflow)
    'missing_invoice',   -- CRM job done, no QBO invoice
    'uf_match',          -- CRM job ↔ UF deposit reconciled
    'unmatched_job',     -- CRM job done, no UF deposit found
    'unmatched_uf'       -- UF deposit, no CRM job match
  ));

-- ─── hardcore_cleanup_items: widen resolution CHECK ─────────────────────────
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'hardcore_cleanup_items'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%je_writeoff%'
  LIMIT 1;
  IF c_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE hardcore_cleanup_items DROP CONSTRAINT ' || quote_ident(c_name);
  END IF;
END $$;

ALTER TABLE hardcore_cleanup_items
  ADD CONSTRAINT hardcore_cleanup_items_resolution_check
  CHECK (resolution IN (
    -- v1 resolutions (existing)
    'pending',
    'je_writeoff',
    'direct_void',
    'keep',
    'manual',
    'executed',
    'failed',
    'skipped',
    -- v2 resolutions (new)
    'push_invoice',     -- CRM job → push as new invoice to QBO (V2 will use createInvoice)
    'apply_payment',    -- UF payment → apply to invoice(s) (V2 will use applyPayment)
    'ask_client',       -- generate "ask the client" email (reuses UF Audit gen)
    'split_deposit'     -- defer to V3 — manual handoff for now
  ));

-- ─── hardcore_cleanup_items: new columns for UF + preview ───────────────────
-- All nullable — v1 rows leave them blank, v2 rows populate as relevant.

ALTER TABLE hardcore_cleanup_items
  ADD COLUMN IF NOT EXISTS uf_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS uf_payment_date DATE,
  ADD COLUMN IF NOT EXISTS uf_payment_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS uf_customer_name TEXT,
  -- proposed_action: the exact QBO op body the bookkeeper sees in /preview
  -- before clicking "Confirm push." Stored when /resolve sets a resolution
  -- that requires a QBO write (push_invoice / apply_payment).
  -- Shape: { kind: 'invoice'|'payment_apply'|'je', body: {...}, warnings: [] }
  ADD COLUMN IF NOT EXISTS proposed_action JSONB,
  -- crm_job_ids: for 1:N bulk-deposit matches — the N CRM job UUIDs that
  -- a single UF payment covers. Supplements matched_crm_job_id (which is
  -- the 1:1 case).
  ADD COLUMN IF NOT EXISTS crm_job_ids UUID[];

-- ─── hardcore_cleanup_items: relax qbo_invoice_id NOT NULL ──────────────────
-- v2 item types (unmatched_uf, missing_invoice, unmatched_job) don't have
-- a QBO invoice to point at. Drop the NOT NULL so these can be inserted.
-- v1 inserts always populate this column anyway.
ALTER TABLE hardcore_cleanup_items
  ALTER COLUMN qbo_invoice_id DROP NOT NULL;

COMMENT ON COLUMN hardcore_cleanup_items.proposed_action IS
  'V2: pre-computed QBO write payload shown in the preview modal before bookkeeper confirms push. Lets the user review exact changes (JE bodies, invoice payloads, payment-update bodies) without hitting QBO.';
COMMENT ON COLUMN hardcore_cleanup_items.crm_job_ids IS
  'V2: 1:N bulk-deposit matches — array of CRM job UUIDs that this single UF payment covers. Used when one $5000 deposit pays off jobs A + B + C.';

-- ─── New table: hardcore_cleanup_uf_payments ────────────────────────────────
-- Snapshot of UF deposits at scan time so the review screen is stable even
-- if the underlying QBO data changes between scan and finalize. Mirrors
-- hardcore_cleanup_crm_jobs which does the same for CRM data.
CREATE TABLE IF NOT EXISTS hardcore_cleanup_uf_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES hardcore_cleanup_runs(id) ON DELETE CASCADE,

  qbo_payment_id TEXT NOT NULL,
  qbo_object_type TEXT,           -- 'Payment' | 'SalesReceipt' | 'Deposit'
  qbo_customer_id TEXT,
  qbo_customer_name TEXT,
  payment_date DATE,
  amount NUMERIC,
  memo TEXT,
  -- For Payment objects: existing LinkedTxn array if already partially applied
  existing_linked_txns JSONB,

  raw_row JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hc_cleanup_uf_payments_run
  ON hardcore_cleanup_uf_payments(run_id);
CREATE INDEX IF NOT EXISTS idx_hc_cleanup_uf_payments_customer
  ON hardcore_cleanup_uf_payments(run_id, qbo_customer_name);

COMMENT ON TABLE hardcore_cleanup_uf_payments IS
  'V2: snapshot of QBO Undeposited Funds deposits at scan time. Stable view for the review UI — actual QBO state might shift between scan and finalize. Each row backs one or more hardcore_cleanup_items (uf_match / unmatched_uf).';

-- ─── Verify ─────────────────────────────────────────────────────────────────
SELECT
  'workflow_version exists' AS check_name,
  COUNT(*) > 0 AS ok
FROM information_schema.columns
WHERE table_name = 'hardcore_cleanup_runs' AND column_name = 'workflow_version'
UNION ALL
SELECT
  'uf_payments table exists',
  COUNT(*) > 0
FROM information_schema.tables
WHERE table_name = 'hardcore_cleanup_uf_payments'
UNION ALL
SELECT
  'new item_type values accepted',
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'hardcore_cleanup_items'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%missing_invoice%'
  )
UNION ALL
SELECT
  'qbo_invoice_id is nullable',
  NOT (SELECT is_nullable = 'NO' FROM information_schema.columns
       WHERE table_name = 'hardcore_cleanup_items' AND column_name = 'qbo_invoice_id');
