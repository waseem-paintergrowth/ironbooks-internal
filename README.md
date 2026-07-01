# Ironbooks App — v2.1

Next.js 15 + Supabase + Claude application for Ironbooks bookkeeping operations.

Supabase backend (`ironbooks-prod`, project ID `omzobviyhrgiqywfjzwo`) is already deployed with all schema, RLS, and 108-account master COA seeded.

--- Ironbooks

## What's Included

| Module | Status |
|--------|--------|
| Module 1: COA Cleanup | ✅ Complete with live execution |
| Module 2: Bank Rules | ✅ Vendor discovery + AI mapping + QBO push |
| Lisa's Flagged Queue | ✅ Cross-job triage center |
| Live Execution Progress | ✅ Real-time terminal log |
| Double Matching UI | ✅ Smart match after QBO connect |
| **Admin Panel** | ✅ User mgmt + audit log + accountability |
| **Immutable Audit Log** | ✅ Even admins can't delete or edit log rows |
| **Auto Role-Change Audit** | ✅ Every permission change logged automatically |

---

## Quick Start

```bash
npm install
cp .env.local.example .env.local
# Fill in: SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, QBO_*, DOUBLE_CLIENT_ID, DOUBLE_CLIENT_SECRET, SLACK_WEBHOOK_URL
npm run dev
# Open http://localhost:3000
```

After first sign-in, run `scripts/setup_first_admin.sql` in Supabase SQL editor to grant admin role.

---

## Full Architecture

```
ironbooks-app/
├── app/
│   ├── api/
│   │   ├── qbo/{connect,callback}/        OAuth init + token exchange
│   │   ├── double/clients/                Lists Double HQ clients + smart match
│   │   ├── jobs/[id]/
│   │   │   ├── analyze/                   Pull COA → Claude → suggestions
│   │   │   ├── execute/                   Kicks off background execution
│   │   │   └── status/                    NEW: live polling endpoint
│   │   ├── actions/[id]/                  NEW: update individual action decisions
│   │   └── rules/
│   │       ├── discover/                  NEW: vendor analysis kickoff
│   │       ├── execute/                   NEW: push approved rules to QBO
│   │       └── [id]/                      NEW: approve/reject single rule
│   │
│   ├── auth/{login,callback}/             Magic-link auth
│   │
│   ├── dashboard/                         KPIs + active jobs
│   ├── flagged/                           NEW: Lisa's flagged queue
│   ├── jobs/
│   │   ├── new/                           Client selector
│   │   └── [id]/
│   │       ├── review/                    AI suggestions table
│   │       └── execute/                   NEW: live terminal-style progress
│   ├── rules/
│   │   ├── new/                           NEW: vendor discovery launcher
│   │   └── [id]/review/                   NEW: rule decisions + bulk approve
│   └── clients/[id]/
│       └── match-double/                  NEW: Double matcher after QBO connect
│
├── components/
│   ├── AppShell.tsx
│   ├── Sidebar.tsx                        Updated with new nav
│   └── TopBar.tsx
│
├── lib/
│   ├── supabase.ts                        Browser/server/service factories
│   ├── qbo.ts                             QBO API + OAuth (520 lines)
│   ├── qbo-rules.ts                       NEW: vendor analysis + BankRule CRUD
│   ├── double.ts                          Double HQ API
│   ├── claude.ts                          COA analysis AI
│   ├── claude-rules.ts                    NEW: rule analysis AI
│   ├── executor.ts                        v2: writes progress to audit_log
│   ├── database.types.ts                  Auto-generated, includes rule tables
│   └── master_coa.json                    Static reference data
│
├── middleware.ts                          Auth guard
└── scripts/
    └── setup_first_admin.sql              Run after first signup
```

---

## Key Workflows

### Module 1: COA Cleanup (existing, enhanced)

```
1. Dashboard → "New COA Cleanup"
2. Pick client → POST /api/jobs → status='draft'
3. Background analyze starts automatically
4. Review page polls until ai_completed_at set
5. Review each row, change action if needed
   - "flag" action sends to Lisa's queue
6. Click "Approve & Execute"
7. → /jobs/[id]/execute live progress page
   - Polls /api/jobs/[id]/status every 1.5s
   - Shows real-time terminal log
   - Progress bar based on action completion %
   - Color-coded events: green=success, red=error, yellow=warning
8. Background work via Next.js after() runs the executor
9. Page auto-updates as audit_log entries appear
10. Slack notification + Double sync on completion
```

### Module 2: Bank Rules (NEW)

```
1. Sidebar → "Bank Rules"
2. Select client + lookback (3/6/12 months)
3. POST /api/rules/discover starts background job
4. Page navigates to /rules/[id]/review (auto-refreshes until ready)
5. Backend:
   a. Pulls Purchase/Bill/Expense/VendorCredit transactions from QBO
   b. Groups by normalized vendor name (strips CO/INC/LLC/#numbers)
   c. Filters to vendors with 2+ transactions
   d. Sends to Claude Opus with master COA + tax context
   e. Claude returns: vendor → account mapping, confidence, requires_approval flag
   f. Saves as bank_rules rows with status='pending'
6. User reviews:
   - Bulk approve all 90%+ confidence non-flagged rules
   - Individual approve/reject/flag with override
   - Sensitive vendors (payroll, tax, owner) auto-flagged
7. Click "Push N Rules to QBO"
8. POST /api/rules/execute creates BankRule entities in QBO
   - Each rule: Condition (Description Contains "vendor") → Action (CategoryId)
9. Status becomes 'pushed' - rules now auto-categorize future transactions
```

### Lisa's Flagged Queue (NEW)

```
1. Sidebar shows live count badge of flagged items
2. Click "Flagged Queue"
3. Server pulls all coa_actions with action='flag' across active jobs
4. Grouped by client, shows context: why flagged, AI confidence, transaction count
5. For each item, decide inline: Keep / Rename to.../ Delete
6. PATCH /api/actions/[id] saves the decision
7. Audit log records the resolution
8. When all flags on a job are resolved:
   - flagged_for_lisa=false
   - lisa_reviewed_by + lisa_reviewed_at set
9. Job can now proceed to execution
```

### Admin Panel (NEW — financial compliance)

```
/admin                              Overview: team stats, compliance status, recent activity
/admin/users                        Invite, deactivate, change roles
/admin/users/[id]                   Per-user activity timeline + drilldown
/admin/audit                        Searchable immutable audit log with CSV export
```

**Roles:**
- `admin` — Full access. Can invite users, change roles, see audit log
- `lead` — Can review flagged items + read audit log (Lisa's role)
- `bookkeeper` — Standard team member, can do cleanups + rules
- `viewer` — Read-only

**Compliance features:**
- ✅ Audit log is **immutable** — even admins cannot UPDATE or DELETE rows
- ✅ Every role/permission change automatically writes to audit_log via DB trigger
- ✅ All API mutations include `user_id` + timestamp
- ✅ Admins cannot demote themselves (must ask another admin)
- ✅ CSV export of any filtered audit slice (for SOC2/financial audits)
- ✅ Self-isolating: service-role calls bypass RLS but every action gets logged

**Invite flow:**
1. Admin clicks "Invite Team Member" on `/admin/users`
2. Enters email + name + role
3. `POST /api/admin/users/invite` calls `supabase.auth.admin.inviteUserByEmail()`
4. Supabase sends magic-link email
5. User row pre-provisioned with role + `invited_by` linkage
6. New user clicks link → already signed in with proper role

### Double Matching

```
1. After QBO OAuth completes, /api/qbo/callback creates a stub client_link
2. User redirected to /clients/[id]/match-double
3. Page calls /api/double/clients?qbo_realm=...
4. Backend fetches Double client list + computes smart match
5. UI shows:
   - Editable QBO client name + jurisdiction + state
   - Suggested Double match (with confidence score)
   - Searchable list of all Double clients
6. User confirms or picks different one
7. Updates client_link with double_client_id + final fields
8. Redirects to dashboard
```

---

## API Reference

### Jobs (COA Cleanup)

- `POST /api/jobs/[id]/analyze` — start AI analysis (idempotent)
- `POST /api/jobs/[id]/execute` — kick off background execution
- `GET /api/jobs/[id]/status?since=ISO` — poll for live progress
- `PATCH /api/actions/[id]` — update single action decision

Body for action update:
```json
{ "action": "keep|rename|delete|flag", "new_name": "...", "notes": "..." }
```

### Rules (Bank Rules)

- `POST /api/rules/discover` — start vendor discovery
  ```json
  { "client_link_id": "uuid", "months": 6 }
  ```
- `POST /api/rules/execute` — push approved rules to QBO
  ```json
  { "discovery_job_id": "uuid" }
  ```
- `PATCH /api/rules/[id]` — update single rule
  ```json
  { "status": "approved|rejected|pending", "target_account_name": "...", "vendor_pattern": "..." }
  ```

### Admin (NEW)

- `POST /api/admin/users/invite` — invite + provision a new user
  ```json
  { "email": "lisa@ironbooks.com", "full_name": "Lisa Smith", "role": "lead" }
  ```
- `PATCH /api/admin/users/[id]` — update role or active status
  ```json
  { "role": "lead", "is_active": true }
  ```
- `GET /api/admin/audit` — searchable audit log
  Query params: `user_id`, `client_link_id`, `job_id`, `event_type`, `since`, `until`, `limit`

### QBO + Double

- `GET /api/qbo/connect?client_link_id=uuid|new` — OAuth init
- `GET /api/qbo/callback` — OAuth exchange (don't call directly)
- `GET /api/double/clients?qbo_realm=...` — list + smart match

---

## Database Schema Highlights

### New in v2

- `bank_rules` — added: `status`, `ai_confidence`, `ai_reasoning`, `sample_descriptions`, `transaction_count`, `total_amount`, `discovery_job_id`
- `rule_discovery_jobs` — NEW table for rule discovery runs

### Key Tables

- `users` — Ironbooks team (admin/lead/bookkeeper/viewer)
- `master_coa` — 108 accounts (54 US + 54 CA) with tax_treatment JSONB
- `client_links` — QBO ↔ Double client pairing
- `coa_jobs` — COA cleanup runs (status workflow)
- `coa_actions` — Per-account decisions within a job
- `audit_log` — Event stream for live progress + history
- `bank_rules` — Vendor → account mapping rules
- `rule_discovery_jobs` — Rule discovery runs

---

## Deployment Checklist

- [ ] Grab service_role key from Supabase dashboard
- [ ] Anthropic API key from console.anthropic.com
- [ ] Create Intuit Developer app (sandbox + prod credentials)
- [ ] Get Double API credentials from Practice Settings → General → Generate API Key (or ask help@doublehq.com)
- [ ] After deploy, hit `GET /api/double/test` as admin to verify auth + connectivity
- [ ] Configure Slack webhook OR use existing Double→Zapier→Slack flow
- [ ] Deploy to Vercel (`vercel deploy --prod`)
- [ ] Add Vercel custom domain: `ironbooks.paintergrowth.com`
- [ ] Add prod redirect URI to Intuit Developer:
      `https://ironbooks.paintergrowth.com/api/qbo/callback`
- [ ] Run `scripts/setup_first_admin.sql` after first signup
- [ ] Confirm Vercel Pro plan for 5min `maxDuration` on execute endpoints

---

## Gotchas

### Execute uses `after()` for background work
The `/api/jobs/[id]/execute` and `/api/rules/discover` endpoints return immediately and continue working in the background. This requires **Vercel Pro** (the `after()` callback has a 5-minute limit on Pro, less on Hobby).

For multi-hour cleanups, migrate to Inngest or Trigger.dev.

### Live progress is poll-based, not realtime
The status endpoint reads from `audit_log` and the client polls every 1.5s. To upgrade to true realtime, subscribe to Supabase realtime on `audit_log` filtered by `job_id`.

### Rule sensitivity is enforced server-side
Even if the AI says `requires_approval=false`, `validateRuleAnalysis()` will flip it to `true` for vendor patterns matching `payroll|tax|irs|cra|owner|draw|distribution|gusto|adp`. The bulk-approve UI skips any rule with `requires_approval=true`.

### Double API specs (confirmed)
- OAuth2 client_credentials flow; tokens last 24hrs and are cached in-memory per server instance
- Base URL: `https://api.doublehq.com` (paths include `/api/...`)
- Rate limit: 300 req / 5min rolling window per OAuth client; lib/double.ts enforces this client-side
- Client list endpoint hard caps at 100 per page; use `listAllClients()` for full enumeration
- `GET /api/double/test` (admin-only) verifies auth + first API call

### Bank rule push order matters
We push rules sequentially, not in parallel, to avoid hitting QBO's 500/min limit and to keep priority ordering deterministic. For 100+ rules this takes ~30s.

---

## Regenerating Types

After any schema change:

```bash
# Locally (needs Supabase CLI)
npm run types

# Or via the Claude/MCP integration:
# Supabase:generate_typescript_types → save to lib/database.types.ts
```
