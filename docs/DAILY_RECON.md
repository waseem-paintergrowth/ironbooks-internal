# Daily Reconciliation — Runbook

Scaffolded but **not live**. This doc covers what was built, what it does, and the exact steps to flip it on for pilot clients without breaking anything.

---

## What was built

| Layer | File | Purpose |
|---|---|---|
| Schema | `scripts/migration_31_daily_recon.sql` | New tables + `daily_recon_*` columns on `client_links` |
| Worker | `lib/daily-recon.ts` | The pipeline: delta fetch → KB → bank rules → AI → queue/auto-execute. Dry-run by default. |
| Cron entrypoint | `app/api/cron/daily-recon/route.ts` | Iterates enrolled clients, calls the worker. **NOT in `vercel.json`** — dormant. |
| Manual trigger | `app/api/daily-recon/run/[clientId]/route.ts` | Admin-only POST to run worker on one client. Defaults to dry-run. |
| Queue actions | `app/api/daily-recon/queue/[id]/route.ts` | Approve / reject / ask_client on a single queue item. Pushes approvals to QBO. |
| Flag toggle | `app/api/clients/[id]/daily-recon-flag/route.ts` | Admin enroll / unenroll / pause / unpause a client. |
| Bookkeeper UI | `app/today/page.tsx` | "Today" dashboard — per-client review counts. |
| Drill-down UI | `app/today/[clientId]/page.tsx` + `daily-review-table.tsx` | Per-line approve/reject. |
| Admin UI | `app/admin/daily-recon/page.tsx` + `admin-client.tsx` | Enroll clients, trigger dry-runs, inspect runs. |
| Sidebar | `components/Sidebar.tsx` | Added "Today" link in standardItems. |

---

## What it does (when live)

1. **Cron tick** (3× daily, say 1pm/5pm/9pm UTC) hits `/api/cron/daily-recon`.
2. For each client with `daily_recon_enabled = true` and not paused:
   - Pulls QBO transactions where `TxnDate >= last_synced_at` (or last 7 days if first run).
   - Filters out lines already in `processed_qbo_lines` (idempotency guard).
   - Runs each line through: **KB → bank rules → Claude AI**.
   - Web search is **deliberately skipped** in v1 — re-enable once the AI tier is proven reliable.
   - Runs anomaly detection (duplicates, round numbers; more rules TODO).
3. For each line:
   - If `confidence ≥ 0.95` **AND** target account is valid in current COA **AND** no anomaly flags **AND** vendor not in hard-block list **AND** under per-run cap → push to QBO via `reclassifyTransactionLines`.
   - Otherwise → row into `daily_review_queue` for human review.
4. Bumps `client_links.last_synced_at` on success.
5. Writes a `daily_recon_runs` audit row.

### Safety bar (built in)

- **Hard-block patterns**: payroll providers, IRS/CRA, owner draws — always queue regardless of confidence.
- **Per-run auto-execute cap**: 20 lines. If a single run wants to push more than 20, the client gets `daily_recon_paused = true` and the rest get queued. Admin must unpause.
- **Target validation**: account ID must exist in the live QBO COA before write — caught hallucinated/stale account IDs.
- **Per-line try/catch on QBO writes**: if QBO rejects, the line falls into the queue with an anomaly flag noting why.
- **Web search gated at 0.92** (vs 0.95 for direct AI) when re-enabled — slightly higher floor for indirect evidence.

---

## Wiring checklist — to go live

### 1. Apply the migration

```bash
# In Supabase SQL editor, or wherever you run migrations:
psql $DATABASE_URL -f scripts/migration_31_daily_recon.sql
```

Verify:
```sql
SELECT column_name FROM information_schema.columns
  WHERE table_name = 'client_links' AND column_name LIKE 'daily%';
-- Should list: daily_recon_enabled, daily_recon_paused, daily_recon_paused_reason

SELECT table_name FROM information_schema.tables
  WHERE table_name IN ('daily_recon_runs','daily_review_queue','processed_qbo_lines');
-- Should list all three
```

### 2. Pilot — enroll 1-2 clients, dry-run only

1. Go to `/admin/daily-recon`.
2. Pick a small / well-categorized client (something with ≤200 active vendors).
3. Click "Enroll".
4. Click "Dry-run" → inspect the preview rows. Check:
   - Are the AI suggestions sensible?
   - Are auto-execute candidates ones you'd actually approve?
   - Anomaly flags surfacing the right rows?
5. Repeat dry-runs over a few days with different `lookbackDays` settings.

### 3. Decide on auto-execute threshold

Default is `0.95`. From the dry-run output, compute:
- Of the lines marked `would_auto_execute = true`, what % matched the categorization you would have picked?

If ≥ 98% → safe to leave at 0.95.
If 90-97% → raise to 0.97 in `lib/daily-recon.ts` (`AUTO_EXECUTE_CONFIDENCE`).
If < 90% → don't auto-execute yet. Use the queue-only mode (set `AUTO_EXECUTE_CONFIDENCE = 1.1` so nothing is ever ≥ that).

### 4. Register the cron

Edit `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/stripe-invite-detector",
      "schedule": "0 6 * * *"
    },
    {
      "path": "/api/cron/daily-recon?dryRun=true",
      "schedule": "0 13,17,21 * * *"
    }
  ]
}
```

**Start with `?dryRun=true`** — this means the cron fires on schedule but doesn't write to QBO. The `daily_recon_runs` log fills up so you can audit what would have happened.

Run with `dryRun=true` for at least **1 week**. Look at:
- `daily_recon_runs` for failures / abnormal durations
- The would-have-auto-executed counts vs queued — anything dramatic week-over-week?

### 5. Flip to live

When confident:

```json
{
  "path": "/api/cron/daily-recon?dryRun=false",
  "schedule": "0 13,17,21 * * *"
}
```

Watch `/today` for the next 2-3 days. Specifically:
- Did any client get `daily_recon_paused = true`? (per-run cap hit means there's a class of vendor the AI is wrong about; investigate before unpausing)
- Are bookkeepers approving most queued items, or rejecting? High reject rate → confidence threshold needs to go up.

### 6. Re-enable web search (optional, after AI tier is proven)

In `lib/daily-recon.ts`, find the comment block:

```typescript
// Tier 4 (web search) — only for AI-tier lines with confidence <0.7 and real vendor name
// SCAFFOLD: we deliberately skip web search in the first cut of daily recon ...
```

Replace the `void webSearchVendor;` line with the actual loop — copy/adapt from the web search step in `app/api/reclass/[id]/web-search-chunk/route.ts`. Recommend:
- Cap at 50 vendors per run
- Per-vendor 25s timeout
- Auto-execute floor at 0.92 (already wired via `WEB_SEARCH_AUTO_FLOOR`)

---

## Test on a small scale (right now, without going live)

You can exercise the entire pipeline without touching `vercel.json` or QBO:

1. Apply the migration.
2. Open `/admin/daily-recon`.
3. Enroll a test client (or a real client — enrollment alone doesn't fire the cron).
4. Click "Dry-run" with whatever `lookbackDays` value you want.
5. The result panel shows everything the worker would do, including the preview table.
6. Browse to `/today` — empty unless you ran the worker in non-dry-run mode (which the manual trigger won't do without `?dryRun=false`).
7. To populate the review queue without QBO writes, hit:
   ```
   POST /api/daily-recon/run/<clientId>?dryRun=false
   ```
   Then visit `/today/<clientId>` and try approve / reject / ask_client buttons. **Caution: this WILL push approvals to QBO**.

---

## Anomaly rules — current and TODO

**Currently implemented** (in `detectAnomalies()`):
- `duplicate_same_day` — same vendor + amount + date as another line in this batch
- `round_number` — exact $1000, $5000, ..., $50000 transactions

**TODO** (each is one new function call inside `detectAnomalies`):
- `new_vendor` — vendor never seen in `bank_rules` / KB / `reclassifications` for this client
- `unusual_amount` — >3σ from this vendor's historical mean for this client
- `missing_recurring` — known monthly vendor (rent, software) hasn't posted in expected window
- `stale_period` — transaction dated in a QBO-closed period
- `manual_entry_on_bank_fed` — manual entry on an account that has a bank feed (potential dup of feed)

Each requires a small DB-backed lookup; left out of v1 to keep the worker pure and fast.

---

## When to pause a client

Auto-pause happens when:
- `auto_executed >= MAX_AUTO_PER_RUN` (20) in a single run — likely a regression or a vendor pattern that needs review.

Manual pause via `/admin/daily-recon` — for things like:
- Client switching CPA mid-cleanup
- Books on hold during ownership change
- You're testing a new prompt and don't want production data touched

Unpause is one click on the same panel.

---

## Future: end-of-month close prep

Sketched but not built. A separate monthly cron would:
- On last business day of month, run extended pipeline per enrolled client
- Generate "Ready to close" PDF: P&L preview, BS preview, recon status, list of unresolved queue items
- If queue is empty → optionally auto-set QBO close date
- Surface a "Close month" button on the client card

Code stub location: would live in `lib/monthly-close-prep.ts` (TBD), called from `app/api/cron/monthly-close-prep/route.ts` (TBD).
