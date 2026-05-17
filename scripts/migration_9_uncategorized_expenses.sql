-- Migration 9: Add "Uncategorized Expenses" catch-all account to master COA
-- Run in Supabase SQL editor.
--
-- This account is auto-created in QBO and used as a fallback when the AI
-- cannot determine the correct category for a transaction. Bookkeepers can
-- then review and recategorize from the Uncategorized Expenses register.

INSERT INTO master_coa (
  jurisdiction, account_name, parent_account_name, is_parent,
  qbo_account_type, qbo_account_subtype, sort_order, section,
  expense_category, notes, is_required
)
VALUES
  ('US', 'Uncategorized Expenses', NULL, false,
   'Expense', 'OtherMiscellaneousExpense', 9999, 'operating_expense',
   'general_operating',
   'Catch-all for transactions that could not be automatically categorized. Review and reclassify as needed.',
   false),
  ('CA', 'Uncategorized Expenses', NULL, false,
   'Expense', 'OtherMiscellaneousExpense', 9999, 'operating_expense',
   'general_operating',
   'Catch-all for transactions that could not be automatically categorized. Review and reclassify as needed.',
   false)
ON CONFLICT DO NOTHING;
