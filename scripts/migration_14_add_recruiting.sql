-- Migration 14: Add "Recruiting" to all industry COAs (US + CA)
--
-- Covers job-board fees (Indeed, ZipRecruiter), recruiter agency fees,
-- background checks, job-ad spend. Grouped under Salaries & Payroll
-- (expense_category) since it's hiring-related; QBO subtype
-- PayrollExpenses keeps it sitting alongside the other payroll lines.
--
-- Sort order 460 — between "Employee Benefits – Admin & Sales" (450)
-- and "Accounting & Bookkeeping" (500).
--
-- Idempotent: skips any (industry, jurisdiction) row that already has
-- a Recruiting account.

INSERT INTO master_coa (
  jurisdiction, industry,
  account_name, section, qbo_account_type, qbo_account_subtype,
  expense_category, parent_account_name, is_parent, is_required, sort_order, notes
)
SELECT
  j.jurisdiction::jurisdiction_code,
  i.industry,
  'Recruiting'                        AS account_name,
  'operating_expense'::account_section AS section,
  'Expense'                            AS qbo_account_type,
  'PayrollExpenses'                    AS qbo_account_subtype,
  'salaries_payroll'::expense_category AS expense_category,
  NULL                                 AS parent_account_name,
  false                                AS is_parent,
  false                                AS is_required,
  460                                  AS sort_order,
  'Job postings (Indeed, ZipRecruiter), recruiter agency fees, background checks, job-ad spend' AS notes
FROM
  (VALUES ('US'), ('CA')) AS j(jurisdiction)
CROSS JOIN (VALUES
  ('painters'),
  ('hvac'),
  ('plumbers'),
  ('roofers'),
  ('electricians'),
  ('remodelers'),
  ('landscapers'),
  ('general_contractors'),
  ('chimney_sweepers')
) AS i(industry)
WHERE NOT EXISTS (
  SELECT 1 FROM master_coa m
  WHERE m.industry = i.industry
    AND m.jurisdiction::text = j.jurisdiction
    AND m.account_name = 'Recruiting'
);

-- Verify: should show 18 rows (9 industries × 2 jurisdictions) after first run.
SELECT industry, jurisdiction, account_name, sort_order
FROM master_coa
WHERE account_name = 'Recruiting'
ORDER BY industry, jurisdiction;
