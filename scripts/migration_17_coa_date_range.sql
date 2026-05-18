-- Migration 17: scope COA cleanup to a date range
--
-- The executor was using 2000-01-01 → today for every merge — pulling
-- ALL transactions across all history. For a client with years of data
-- that's slow AND it rewrites closed-period transactions, which is an
-- audit risk.
--
-- Now the bookkeeper picks a date range up front. Renames + creates
-- happen regardless (they don't touch transactions), but merges + the
-- "is the source empty?" check that gates inactivation only look at
-- transactions inside the range. Older transactions stay on the source,
-- and if the source still has them the inactivation flags for manual.
--
-- Defaults: This Calendar Year, with options for fiscal + this+last.

ALTER TABLE coa_jobs
  ADD COLUMN IF NOT EXISTS date_range_start date,
  ADD COLUMN IF NOT EXISTS date_range_end date,
  ADD COLUMN IF NOT EXISTS date_range_preset text;

-- Backfill any in-flight or completed jobs with a sane default so the
-- executor doesn't blow up on null when reading the column.
UPDATE coa_jobs
SET date_range_start = '2000-01-01',
    date_range_end = CURRENT_DATE,
    date_range_preset = 'legacy_all_time'
WHERE date_range_start IS NULL;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'coa_jobs'
  AND column_name IN ('date_range_start', 'date_range_end', 'date_range_preset');
