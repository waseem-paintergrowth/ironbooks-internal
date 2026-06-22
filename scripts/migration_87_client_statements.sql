-- Migration 87 — Client statements (AI-identified, renamed, filed)
-- =========================================================================
-- One row per uploaded bank/credit-card/loan statement. The intake pipeline
-- (lib/statement-intake) reads the PDF with Claude, identifies the account +
-- period, matches it to a QBO account, renames it, and files it here so it
-- shows in the client's Statements section and (later) the BS cleanup view.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

create table if not exists client_statements (
  id uuid primary key default gen_random_uuid(),
  client_link_id uuid not null references client_links(id) on delete cascade,
  storage_path text not null,                 -- path in the client-uploads bucket
  original_name text,
  display_name text not null,                 -- "<Account> – Mon YYYY"
  institution text,
  account_label text,                         -- as printed on the statement
  last4 text,
  account_kind text,                          -- bank | credit_card | loan | unknown
  matched_qbo_account_id text,
  matched_account_name text,
  match_confidence text,                      -- high | medium | low | none
  period_month int,                           -- 1-12
  period_year int,
  statement_end_date date,
  ending_balance numeric,
  status text not null default 'processed',   -- processing | processed | unmatched | failed
  notes text,
  uploaded_by uuid references users(id),      -- null when the client uploaded it
  uploaded_via text not null default 'portal',-- 'portal' | 'bookkeeper'
  created_at timestamptz not null default now()
);
create index if not exists client_statements_client_idx on client_statements(client_link_id);
create index if not exists client_statements_account_idx on client_statements(matched_qbo_account_id);
