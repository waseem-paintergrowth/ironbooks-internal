-- Migration 91 — Resumable reclass execution
-- =========================================================================
-- Large reclass jobs (e.g. a full prior-year backlog of 1,000+ transactions)
-- can't post all their QBO updates inside one 300s serverless background pass,
-- so the run was getting killed mid-loop and auto-failed by the watchdog with
-- 0 progress shown. The executor now works in time-budgeted batches: when a
-- pass hits its budget with rows still pending, it pauses with this flag set
-- and the open job page kicks the next pass — until the queue is drained.
--
-- Run in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/omzobviyhrgiqywfjzwo/sql/new

alter table reclass_jobs
  add column if not exists execution_resumable boolean not null default false;
