-- ============================================================================
-- Migration 35: Uncategorized Income Recovery
-- ============================================================================
-- Solves the "deposit landed but never got applied to A/R" problem.
--
-- Two flavours of mess:
--   1. Deposit posted directly to "Uncategorized Income" because the previous
--      bookkeeper didn't know who the customer was → A/R Aging still shows
--      the invoice as open even though the money is in the bank.
--   2. JEs hitting Uncategorized Income from bank-feed imports with no
--      customer attached.
--
-- Workflow (mirrors UF Audit):
--   1. Scan: pull every line hitting Uncategorized Income + every open invoice
--   2. Deterministic match by amount + (customer if known) within window
--   3. Optional Claude pass to infer customer from bank descriptions
--      (e.g. "ACH MARTEL CONST 38136" → Martel Construction)
--   4. Bookkeeper reviews + picks resolution per item
--   5. Finalize: post JEs / Payments to QBO
--
-- Safety rails on the Claude pass — see ai_status column. Never silent-fail.
-- ============================================================================

CREATE TABLE IF NOT EXISTS uncat_income_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'scanning'
    CHECK (status IN ('scanning','review','finalizing','finalized','failed','cancelled')),

  -- Source account being audited
  uncat_account_qbo_id TEXT,
  uncat_account_name TEXT,
  scan_from DATE,
  scan_to DATE,

  -- Aggregate stats
  deposits_scanned INTEGER NOT NULL DEFAULT 0,
  open_invoices_scanned INTEGER NOT NULL DEFAULT 0,
  exact_single_count INTEGER NOT NULL DEFAULT 0,
  exact_multi_count INTEGER NOT NULL DEFAULT 0,
  no_match_count INTEGER NOT NULL DEFAULT 0,
  total_uncat_amount NUMERIC NOT NULL DEFAULT 0,

  -- Claude inference safety status. NEVER silent-fail:
  --   'not_attempted' — no descriptions needed Claude help
  --   'running'       — request in flight (5-min zombie cap)
  --   'success'       — finished, results applied
  --   'partial'       — finished but some items errored mid-batch
  --   'timeout'       — hit hard 90s timeout
  --   'failed'        — exception bubbled up
  --   'skipped'       — explicitly disabled
  ai_status TEXT NOT NULL DEFAULT 'not_attempted'
    CHECK (ai_status IN ('not_attempted','running','success','partial','timeout','failed','skipped')),
  ai_started_at TIMESTAMPTZ,
  ai_finished_at TIMESTAMPTZ,
  ai_duration_ms INTEGER,
  ai_items_considered INTEGER NOT NULL DEFAULT 0,
  ai_items_inferred INTEGER NOT NULL DEFAULT 0,
  ai_error_message TEXT,

  duration_ms INTEGER,
  error_message TEXT,

  finalized_at TIMESTAMPTZ,
  finalized_by UUID REFERENCES users(id) ON DELETE SET NULL,
  finalize_results JSONB
);

CREATE INDEX IF NOT EXISTS idx_uncat_income_scans_client
  ON uncat_income_scans(client_link_id, created_at DESC);

COMMENT ON TABLE uncat_income_scans IS
  'One row per Uncategorized Income Recovery run. Scans deposits/JEs hitting Uncategorized Income and matches them against open A/R invoices.';
COMMENT ON COLUMN uncat_income_scans.ai_status IS
  'Tracks Claude customer-inference pass. NEVER allow null/silent failure — UI surfaces non-success states with a banner so bookkeepers know AI assist did not run.';


CREATE TABLE IF NOT EXISTS uncat_income_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL REFERENCES uncat_income_scans(id) ON DELETE CASCADE,
  client_link_id UUID NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,

  -- Source transaction identity
  qbo_txn_id TEXT NOT NULL,
  qbo_txn_type TEXT NOT NULL,         -- 'Deposit', 'JournalEntry', 'Deposit.Line'
  qbo_line_id TEXT,                   -- the specific line hitting Uncat Income
  sync_token TEXT,                    -- for reclass operations
  txn_date DATE NOT NULL,
  amount NUMERIC NOT NULL,
  description TEXT,
  private_note TEXT,
  bank_account_id TEXT,
  bank_account_name TEXT,
  customer_qbo_id TEXT,               -- if QBO already has one attached
  customer_name TEXT,

  -- Classification
  -- exact_single        — exactly 1 open invoice matches amount
  -- exact_multi         — 2+ open invoices match amount (bookkeeper picks)
  -- ai_inferred         — Claude inferred a customer; check that customer's invoices
  -- no_match            — nothing matches
  classification TEXT NOT NULL
    CHECK (classification IN ('exact_single','exact_multi','ai_inferred','no_match')),
  candidate_invoice_ids JSONB DEFAULT '[]'::jsonb,
  -- e.g. [{ "qbo_invoice_id":"123", "doc_number":"INV-1042", "customer_name":"Acme",
  --        "txn_date":"2025-05-12", "balance":6267.04 }]

  -- AI inference outcome on this row (when applicable)
  ai_inferred_customer_id TEXT,
  ai_inferred_customer_name TEXT,
  ai_confidence NUMERIC,              -- 0..1
  ai_reasoning TEXT,
  ai_error TEXT,                      -- per-item error if the row failed mid-batch

  -- Auto-approve flag — set when classification=exact_single AND amount < $10k
  auto_approve_eligible BOOLEAN NOT NULL DEFAULT FALSE,

  -- Resolution workflow
  resolution TEXT NOT NULL DEFAULT 'pending'
    CHECK (resolution IN (
      'pending',
      'apply_to_invoice',         -- JE moves balance from Uncat → A/R (customer + invoice)
      'customer_deposits',        -- JE moves to Customer Deposits liability
      'ask_client',               -- queue for confirmation email
      'write_off',                -- JE moves to Bad Debt or similar
      'move_to_revenue',          -- recategorize to correct P&L account
      'manual_investigation',     -- flag, do nothing automated
      'executed',
      'failed',
      'skipped'
    )),
  target_invoice_qbo_id TEXT,
  target_account_qbo_id TEXT,
  target_account_name TEXT,
  target_customer_qbo_id TEXT,
  target_customer_name TEXT,
  resolution_notes TEXT,
  resolution_je_id TEXT,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  execution_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uncat_income_items_scan
  ON uncat_income_items(scan_id);
CREATE INDEX IF NOT EXISTS idx_uncat_income_items_scan_classification
  ON uncat_income_items(scan_id, classification);
CREATE INDEX IF NOT EXISTS idx_uncat_income_items_scan_resolution
  ON uncat_income_items(scan_id, resolution);

COMMENT ON COLUMN uncat_income_items.classification IS
  'How the matcher classified this deposit: exact_single (one invoice matches), exact_multi (multiple candidates), ai_inferred (Claude suggested a customer), no_match (no candidates found).';
COMMENT ON COLUMN uncat_income_items.auto_approve_eligible IS
  'True when classification=exact_single AND amount under safety threshold ($10k). UI can bulk-confirm these with one click.';
