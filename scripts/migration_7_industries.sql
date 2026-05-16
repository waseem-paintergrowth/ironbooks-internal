-- Migration 7: Multi-Industry COAs
-- ──────────────────────────────────
-- Adds an "industry" dimension to the master COA, client_links, and coa_jobs
-- so the app can manage chart-of-account templates for Painters, HVAC,
-- Plumbers, Roofers, Electricians, Remodelers, Landscapers, General
-- Contractors, and Chimney Sweepers.
--
-- Strategy:
--   1. Add industry text columns with default 'painters' (preserves existing data)
--   2. Backfill any NULLs
--   3. For each of the 8 new industries, duplicate the painters rows using
--      INSERT ... SELECT with a CASE expression that renames the 4 industry-
--      specific accounts (labor, materials, subs, revenue) and leaves
--      everything else identical
-- ──────────────────────────────────

-- 1. Add columns
ALTER TABLE master_coa ADD COLUMN IF NOT EXISTS industry text DEFAULT 'painters';

-- client_links already has a legacy "industry_variant" column. Rename it to
-- "industry" for naming consistency with master_coa. If the rename has already
-- happened, the IF EXISTS guards make this a no-op.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'client_links' AND column_name = 'industry_variant'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'client_links' AND column_name = 'industry'
  ) THEN
    ALTER TABLE client_links RENAME COLUMN industry_variant TO industry;
  END IF;
END $$;

ALTER TABLE client_links ADD COLUMN IF NOT EXISTS industry text DEFAULT 'painters';

-- 2. Backfill
UPDATE master_coa SET industry = 'painters' WHERE industry IS NULL;
UPDATE client_links SET industry = 'painters' WHERE industry IS NULL;

-- 3. Indexes — common query is "by jurisdiction + industry"
CREATE INDEX IF NOT EXISTS idx_master_coa_industry_jurisdiction ON master_coa(industry, jurisdiction);
CREATE INDEX IF NOT EXISTS idx_client_links_industry ON client_links(industry);

-- 4. Duplicate painters rows into 8 new industries
--    Each block applies a CASE-based rename map for the four industry-specific
--    accounts (labor, materials, subs, revenue).

-- ─── HVAC ───
INSERT INTO master_coa (
  jurisdiction, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, notes, is_required, industry
)
SELECT jurisdiction,
  CASE account_name
    WHEN 'Direct Field Labor – Painting' THEN 'Direct Field Labor – HVAC'
    WHEN 'Paint & Materials'              THEN 'HVAC Parts & Equipment'
    WHEN 'Subcontractors – Painting'      THEN 'Subcontractors – HVAC'
    WHEN 'Painting Revenue'               THEN 'HVAC Service Revenue'
    WHEN 'Remodeling Revenue'             THEN 'HVAC Installation Revenue'
    ELSE account_name
  END,
  parent_account_name, is_parent, qbo_account_type, qbo_account_subtype,
  sort_order, section, expense_category, notes, is_required, 'hvac'
FROM master_coa WHERE industry = 'painters'
ON CONFLICT DO NOTHING;

-- ─── PLUMBERS ───
INSERT INTO master_coa (
  jurisdiction, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, notes, is_required, industry
)
SELECT jurisdiction,
  CASE account_name
    WHEN 'Direct Field Labor – Painting' THEN 'Direct Field Labor – Plumbing'
    WHEN 'Paint & Materials'              THEN 'Pipe, Fittings & Fixtures'
    WHEN 'Subcontractors – Painting'      THEN 'Subcontractors – Plumbing'
    WHEN 'Painting Revenue'               THEN 'Plumbing Revenue'
    WHEN 'Remodeling Revenue'             THEN 'Service & Repair Revenue'
    ELSE account_name
  END,
  parent_account_name, is_parent, qbo_account_type, qbo_account_subtype,
  sort_order, section, expense_category, notes, is_required, 'plumbers'
FROM master_coa WHERE industry = 'painters'
ON CONFLICT DO NOTHING;

-- ─── ROOFERS ───
INSERT INTO master_coa (
  jurisdiction, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, notes, is_required, industry
)
SELECT jurisdiction,
  CASE account_name
    WHEN 'Direct Field Labor – Painting' THEN 'Direct Field Labor – Roofing'
    WHEN 'Paint & Materials'              THEN 'Roofing Materials'
    WHEN 'Subcontractors – Painting'      THEN 'Subcontractors – Roofing'
    WHEN 'Painting Revenue'               THEN 'Roofing Revenue'
    WHEN 'Remodeling Revenue'             THEN 'Repair & Inspection Revenue'
    ELSE account_name
  END,
  parent_account_name, is_parent, qbo_account_type, qbo_account_subtype,
  sort_order, section, expense_category, notes, is_required, 'roofers'
FROM master_coa WHERE industry = 'painters'
ON CONFLICT DO NOTHING;

-- ─── ELECTRICIANS ───
INSERT INTO master_coa (
  jurisdiction, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, notes, is_required, industry
)
SELECT jurisdiction,
  CASE account_name
    WHEN 'Direct Field Labor – Painting' THEN 'Direct Field Labor – Electrical'
    WHEN 'Paint & Materials'              THEN 'Wire, Conduit & Fixtures'
    WHEN 'Subcontractors – Painting'      THEN 'Subcontractors – Electrical'
    WHEN 'Painting Revenue'               THEN 'Electrical Revenue'
    WHEN 'Remodeling Revenue'             THEN 'Service & Repair Revenue'
    ELSE account_name
  END,
  parent_account_name, is_parent, qbo_account_type, qbo_account_subtype,
  sort_order, section, expense_category, notes, is_required, 'electricians'
FROM master_coa WHERE industry = 'painters'
ON CONFLICT DO NOTHING;

-- ─── REMODELERS ───
INSERT INTO master_coa (
  jurisdiction, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, notes, is_required, industry
)
SELECT jurisdiction,
  CASE account_name
    WHEN 'Direct Field Labor – Painting' THEN 'Direct Field Labor – Remodeling'
    WHEN 'Paint & Materials'              THEN 'Building Materials'
    WHEN 'Subcontractors – Painting'      THEN 'Subcontractors – Trades'
    WHEN 'Painting Revenue'               THEN 'Remodeling Revenue'
    WHEN 'Remodeling Revenue'             THEN 'Renovation Revenue'
    ELSE account_name
  END,
  parent_account_name, is_parent, qbo_account_type, qbo_account_subtype,
  sort_order, section, expense_category, notes, is_required, 'remodelers'
FROM master_coa WHERE industry = 'painters'
ON CONFLICT DO NOTHING;

-- ─── LANDSCAPERS ───
INSERT INTO master_coa (
  jurisdiction, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, notes, is_required, industry
)
SELECT jurisdiction,
  CASE account_name
    WHEN 'Direct Field Labor – Painting' THEN 'Direct Field Labor – Landscaping'
    WHEN 'Paint & Materials'              THEN 'Plants, Soil & Hardscape'
    WHEN 'Subcontractors – Painting'      THEN 'Subcontractors – Landscaping'
    WHEN 'Painting Revenue'               THEN 'Landscaping Revenue'
    WHEN 'Remodeling Revenue'             THEN 'Snow Removal & Seasonal Revenue'
    ELSE account_name
  END,
  parent_account_name, is_parent, qbo_account_type, qbo_account_subtype,
  sort_order, section, expense_category, notes, is_required, 'landscapers'
FROM master_coa WHERE industry = 'painters'
ON CONFLICT DO NOTHING;

-- ─── GENERAL CONTRACTORS ───
INSERT INTO master_coa (
  jurisdiction, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, notes, is_required, industry
)
SELECT jurisdiction,
  CASE account_name
    WHEN 'Direct Field Labor – Painting' THEN 'Direct Field Labor – Construction'
    WHEN 'Paint & Materials'              THEN 'Construction Materials'
    WHEN 'Subcontractors – Painting'      THEN 'Subcontractors – Trades'
    WHEN 'Painting Revenue'               THEN 'Construction Revenue'
    WHEN 'Remodeling Revenue'             THEN 'Renovation Revenue'
    ELSE account_name
  END,
  parent_account_name, is_parent, qbo_account_type, qbo_account_subtype,
  sort_order, section, expense_category, notes, is_required, 'general_contractors'
FROM master_coa WHERE industry = 'painters'
ON CONFLICT DO NOTHING;

-- ─── CHIMNEY SWEEPERS ───
INSERT INTO master_coa (
  jurisdiction, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, notes, is_required, industry
)
SELECT jurisdiction,
  CASE account_name
    WHEN 'Direct Field Labor – Painting' THEN 'Direct Field Labor – Cleaning'
    WHEN 'Paint & Materials'              THEN 'Chimney Supplies'
    WHEN 'Subcontractors – Painting'      THEN 'Subcontractors – Cleaning'
    WHEN 'Painting Revenue'               THEN 'Chimney Service Revenue'
    WHEN 'Remodeling Revenue'             THEN 'Inspection & Repair Revenue'
    ELSE account_name
  END,
  parent_account_name, is_parent, qbo_account_type, qbo_account_subtype,
  sort_order, section, expense_category, notes, is_required, 'chimney_sweepers'
FROM master_coa WHERE industry = 'painters'
ON CONFLICT DO NOTHING;
