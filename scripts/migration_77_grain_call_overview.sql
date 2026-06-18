-- Migration 77 — Grain cross-call AI overview cache
-- =========================================================================
-- Caches one AI-generated "who is this client / what's gone on across all
-- their calls" overview per client. Regenerated when the set of matched
-- recordings changes (tracked via `signature`) so the LLM cost stays at a
-- few pennies per client instead of one call per profile view.
--
-- Run in Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

create table if not exists grain_call_overviews (
  client_link_id uuid primary key references client_links(id) on delete cascade,
  overview text not null,                    -- markdown-lite paragraphs
  signature text not null,                   -- count + latest recording stamp
  recording_count int not null default 0,
  generated_at timestamptz not null default now()
);

comment on table grain_call_overviews is
  'Cached AI synthesis of all of a clients Grain calls. Regenerated when signature changes.';
