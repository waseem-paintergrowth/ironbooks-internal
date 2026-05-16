-- Migration: add 'merge' to coa_action enum
-- Run this in the Supabase SQL editor before deploying the updated app code.
-- Safe to run once; Postgres will error if the value already exists (which is fine).

ALTER TYPE coa_action ADD VALUE IF NOT EXISTS 'merge';
