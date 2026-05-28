-- ============================================================================
-- Migration 41: Hardcore BS Cleanup (Phase 1 — Duplicate Invoice Detection)
-- ============================================================================
-- Solves the "client switched CRMs and now QBO has 4 duplicate invoices per
-- real job" mess (e.g. Logan: Drip Jobs created a new invoice per estimate
-- revision, all synced to QBO, A/R now shows $715K phantom balance).
--
-- Phase 1 scope:
--   - Bookkeeper uploads CRM CSV (Drip Jobs / Jobber / generic)
--   - SNAP parses + stores CRM jobs as ground truth
--   - Cross-reference against QBO invoices to detect duplicates
--   - Mega-screen review: bookkeeper picks resolution per duplicate
--     (write-off via JE / direct void / keep / mark for manual)
--   - Finalize pushes approved corrections to QBO
--
-- Phase 2 (future): UF orphan reconciliation, payment-to-invoice matching,
-- stale A/R write-offs, deposit reconciliation — all cross-referenced
-- against the same CRM ground truth.
-- ============================================================================

CREATE TABLE IF NOT EXISTS hardcore_cleanup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'uploading'
    CHECK (status IN (
      'uploading',  -- CSV being processed
      'matching',   -- QBO data being pulled + duplicate detection running
      'review',     -- bookkeeper triaging
      'finalizing', -- pushing corrections to QBO
      'finalized',
      'failed',
      'cancelled'
    )),

  -- Source CRM (drives column-mapping logic)
  crm_source TEXT NOT NULL
    CHECK (crm_source IN ('drip_jobs', 'jobber', 'generic')),
  crm_filename TEXT,

  -- Aggregate stats
  crm_jobs_uploaded INTEGER NOT NULL DEFAULT 0,
  qbo_invoices_scanned INTEGER NOT NULL DEFAULT 0,
  duplicates_detected INTEGER NOT NULL DEFAULT 0,
  duplicates_resolved INTEGER NOT NULL DEFAULT 0,
  duplicates_executed INTEGER NOT NULL DEFAULT 0,
  total_phantom_ar NUMERIC NOT NULL DEFAULT 0,  -- $ amount of detected dupes

  duration_ms INTEGER,
  error_message TEXT,

  finalized_at TIMESTAMPTZ,
  finalized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  finalize_results JSONB
);

CREATE INDEX IF NOT EXISTS idx_hc_cleanup_runs_client
  ON hardcore_cleanup_runs(client_link_id, created_at DESC);

COMMENT ON TABLE hardcore_cleanup_runs IS
  'One row per Hardcore BS Cleanup run. Logan-style cases where the client switched CRMs and QBO is now full of phantom invoices.';


-- CRM jobs uploaded by the bookkeeper. These are the GROUND TRUTH — anything
-- in QBO without a matching CRM job is suspect.
CREATE TABLE IF NOT EXISTS hardcore_cleanup_crm_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES hardcore_cleanup_runs(id) ON DELETE CASCADE,

  -- Normalized fields (parsed from various CRM formats)
  crm_job_id TEXT,                  -- the CRM's own job identifier (if available)
  job_name TEXT,
  customer_name TEXT,
  job_status TEXT,                  -- active / completed / cancelled / pending
  amount NUMERIC,
  job_date DATE,

  -- Original row preserved for debugging + future enrichment
  raw_row JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hc_cleanup_crm_jobs_run
  ON hardcore_cleanup_crm_jobs(run_id);
CREATE INDEX IF NOT EXISTS idx_hc_cleanup_crm_jobs_customer
  ON hardcore_cleanup_crm_jobs(run_id, customer_name);


-- Each detected anomaly becomes one item. Phase 1: only duplicate_invoice.
-- Phase 2 adds more item_types.
CREATE TABLE IF NOT EXISTS hardcore_cleanup_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES hardcore_cleanup_runs(id) ON DELETE CASCADE,
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,

  item_type TEXT NOT NULL
    CHECK (item_type IN (
      'duplicate_invoice',     -- Phase 1
      'orphan_uf_payment',     -- Phase 2
      'stale_ar',              -- Phase 2
      'unmatched_payment'      -- Phase 2
    )),

  -- ─── QBO invoice snapshot ───
  -- The invoice we'd be voiding / writing off. Always present.
  qbo_invoice_id TEXT NOT NULL,
  qbo_invoice_doc_number TEXT,
  qbo_invoice_date DATE,
  qbo_invoice_amount NUMERIC,
  qbo_invoice_balance NUMERIC,
  qbo_customer_id TEXT,
  qbo_customer_name TEXT,
  qbo_invoice_memo TEXT,

  -- ─── Best-matched CRM job (the surviving "real" record) ───
  matched_crm_job_id UUID REFERENCES hardcore_cleanup_crm_jobs(id) ON DELETE SET NULL,
  -- Snapshot of the surviving sibling QBO invoice (the one we'd keep)
  surviving_qbo_invoice_id TEXT,
  surviving_qbo_invoice_doc_number TEXT,

  -- Detection metadata
  confidence NUMERIC NOT NULL DEFAULT 0,  -- 0..1
  reasoning TEXT,

  -- ─── Resolution ───
  resolution TEXT NOT NULL DEFAULT 'pending'
    CHECK (resolution IN (
      'pending',
      'je_writeoff',         -- post a JE: Dr Bad Debt, Cr A/R (preserves filed-period numbers)
      'direct_void',         -- void the invoice in QBO directly
      'keep',                -- not actually a duplicate after review
      'manual',              -- flag for manual handling
      'executed',
      'failed',
      'skipped'
    )),
  resolution_target_account_id TEXT,   -- For je_writeoff (Bad Debt or similar)
  resolution_target_account_name TEXT,
  resolution_notes TEXT,
  resolution_je_id TEXT,                -- once finalized
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  execution_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hc_cleanup_items_run
  ON hardcore_cleanup_items(run_id);
CREATE INDEX IF NOT EXISTS idx_hc_cleanup_items_run_type
  ON hardcore_cleanup_items(run_id, item_type);
CREATE INDEX IF NOT EXISTS idx_hc_cleanup_items_run_resolution
  ON hardcore_cleanup_items(run_id, resolution);

COMMENT ON COLUMN hardcore_cleanup_items.resolution IS
  'je_writeoff = Dr Bad Debt/Cr A/R (preserves filed-period numbers). direct_void = QBO Invoice.Active=false on the invoice itself (use when the period is open). keep = bookkeeper reviewed and the duplicate flag was wrong. manual = flag for handling outside SNAP.';
