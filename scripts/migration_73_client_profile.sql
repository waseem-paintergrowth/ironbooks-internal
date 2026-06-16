-- Migration 73 — Client profile fields
-- =========================================================================
-- Adds the structured business-profile fields we collect on the GHL
-- onboarding form (and partly in Double) as first-class, editable columns
-- on client_links — so a bookkeeper has names, contact info, address, and
-- business characteristics in one place instead of digging through GHL.
--
-- All additive + nullable; existing rows unaffected. Enum-style fields are
-- plain text (options enforced in the UI) to stay flexible without DB
-- migrations every time an option changes. `client_phone` is guarded with
-- IF NOT EXISTS because migration_72_client_phone.sql may have already added
-- it — running both in either order is safe.
--
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

alter table client_links
  -- Contact
  add column if not exists contact_first_name text,
  add column if not exists contact_last_name text,
  add column if not exists client_phone text,
  -- Business identity
  add column if not exists legal_business_name text,
  add column if not exists trade_type text,              -- type of trade / business
  add column if not exists corporate_type text,          -- Sole Prop / Corp / LLC / etc.
  add column if not exists fiscal_year_end text,          -- e.g. "December 31"
  add column if not exists country text,                  -- display copy of country (jurisdiction enum stays the system field)
  -- Address
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists city text,
  add column if not exists postal_code text,
  -- Business characteristics (onboarding form)
  add column if not exists annual_revenue_range text,     -- Under $100K … Over $3M
  add column if not exists taxes_up_to_date text,         -- yes / no / unsure
  add column if not exists prior_bookkeeper text,         -- last bookkeeper / accountant
  add column if not exists accounting_software text,      -- QuickBooks Online / Xero / …
  add column if not exists payroll_provider text,
  add column if not exists employee_count_range text,     -- Just me … 30+
  add column if not exists uses_business_cards text,      -- yes / no / unsure
  add column if not exists keeps_receipts text,           -- digitally / paper / sometimes / no
  add column if not exists bank_connected_to_software text, -- yes / no / not sure
  -- Profile bookkeeping
  add column if not exists profile_updated_at timestamptz;

comment on column client_links.trade_type is 'Type of trade/business (free text from onboarding form)';
comment on column client_links.corporate_type is 'Legal structure: Sole Proprietor / Partnership / Corporation / LLC / S-Corp / etc.';
comment on column client_links.annual_revenue_range is 'Approx annual revenue band from onboarding form';
comment on column client_links.country is 'Display country; jurisdiction (US/CA enum) remains the system tax field';
comment on column client_links.profile_updated_at is 'Last time a bookkeeper edited the client profile details';
