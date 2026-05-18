-- Migration 18: reset any job that has the 'legacy_all_time' backfill so it
-- can't be re-executed with the all-time scope.
--
-- Migration 17 originally backfilled pre-existing jobs to (2000-01-01, today,
-- 'legacy_all_time') so the column was non-null. That preserved column
-- integrity, but it also let the executor read those legacy values and run
-- with an unsafe scope — which is exactly what burned Renaissance.
--
-- Strategy: blank out the legacy values so the executor's new strict guard
-- ("date_range_start and date_range_end must be present") fires and refuses
-- to run. The bookkeeper has to re-pick a scope before re-executing.
--
-- The executor also enforces preset ∈ {cy, fy, cy_plus_1, fy_plus_1} and
-- date_range_start no older than 3 years — defense in depth.

UPDATE coa_jobs
SET date_range_start = NULL,
    date_range_end = NULL,
    date_range_preset = NULL,
    error_message = COALESCE(error_message || ' · ', '') ||
      'Migration 18: cleared legacy all-time scope. Re-pick a date range before next execute.'
WHERE date_range_preset = 'legacy_all_time';

-- Verify
SELECT id, status, date_range_start, date_range_end, date_range_preset
FROM coa_jobs
WHERE date_range_preset IS NULL
   OR date_range_preset = 'legacy_all_time';
