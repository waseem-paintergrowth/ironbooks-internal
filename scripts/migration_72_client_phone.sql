-- Migration 72 — client_links.client_phone
-- =========================================================================
-- The admin Clients list (Users page → Clients tab) shows each client's
-- name, email, and PHONE. client_links already has client_email but no phone
-- column, so add one. Additive + nullable — existing rows are unaffected.
--
-- Phone can be edited inline in the admin Clients tab (PATCH /api/clients/[id]),
-- and the onboarding "Create client" handoff can populate it from the GHL
-- onboarding_leads.phone going forward. Until set, the list falls back to
-- onboarding_leads.phone (when that table exists) and otherwise shows "—".
--
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

alter table client_links add column if not exists client_phone text;
