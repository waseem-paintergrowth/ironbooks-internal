/**
 * Fleet Health snapshot builder.
 *
 * One function — buildFleetSnapshot() — that returns everything the
 * dashboard needs in a single response. Internally fans out to ~10
 * Supabase queries in parallel; total time on the production data set
 * we have today is ~300ms.
 *
 * Read-only. No QBO calls (everything's already-persisted state). No
 * Anthropic. Cheap to call on every page load — but if we ever need
 * to materialize, the shape is stable enough to drop into a view.
 *
 * Five panels mirror the spec:
 *   A: Job failures               — anything in status='failed'
 *   B: Stuck workflows            — too-long-at intermediate states
 *   C: Integration health         — QBO tokens, Stripe links, bank rules
 *   D: Cleanup pipeline drift     — onboarding stalled, AR aging
 *   E: Bookkeeper workload        — open-work distribution
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// Severity buckets for the header strip + per-row color.
export type Severity = "failing" | "warning" | "healthy";

export interface FleetClient {
  id: string;
  name: string;
  bookkeeper_id: string | null;
  bookkeeper_name: string | null;
  jurisdiction: string | null;
}

export interface FailedJob {
  client: FleetClient;
  kind:
    | "reclass"
    | "coa"
    | "hardcore_cleanup"
    | "stripe_recon"
    | "bank_recon";
  job_id: string;
  failed_at: string; // ISO
  age_hours: number;
  error_message: string;
  dollars_at_risk: number | null;
}

export interface StuckItem {
  client: FleetClient;
  kind:
    | "reclass_in_review"
    | "reclass_web_search_paused"
    | "coa_in_review"
    | "hardcore_cleanup_review"
    | "senior_review_pending"
    | "mom_not_closed";
  reference_id: string; // job id OR client_link_id depending on kind
  started_at: string;
  age_days: number;
  detail: string; // human-readable "Reclass for Brady Brown, $X at stake"
  dollars_at_risk: number | null;
}

export interface IntegrationIssue {
  client: FleetClient;
  kind:
    | "qbo_token_stale"
    | "qbo_token_expired"
    | "stripe_link_no_response"
    | "bank_rules_unexported"
    | "double_unmatched";
  detail: string;
  age_days: number;
  // Action hint — what the bookkeeper should do. Used to suggest the
  // single-button label on the row (Reconnect / Resend / Export / ...).
  recommended_action: string;
}

export interface DriftItem {
  client: FleetClient;
  kind: "onboarding_stalled" | "no_recent_activity";
  detail: string;
  age_days: number;
}

export interface BookkeeperLoad {
  bookkeeper_id: string;
  bookkeeper_name: string;
  active_clients: number;
  open_jobs: number;
  failing_jobs: number;
  last_activity: string | null;
}

export interface ActivityEvent {
  occurred_at: string;
  event_type: string;
  user_name: string | null;
  client_link_id: string | null;
  client_name: string | null;
  summary: string;
}

export interface FleetSnapshot {
  generated_at: string;
  // Header strip
  total_clients: number;
  healthy: number;
  warning: number;
  failing: number;
  total_dollars_at_risk: number;
  // Panels
  panel_a_job_failures: FailedJob[];
  panel_b_stuck_workflows: StuckItem[];
  panel_c_integration_health: IntegrationIssue[];
  panel_d_pipeline_drift: DriftItem[];
  panel_e_bookkeeper_workload: BookkeeperLoad[];
  activity_feed: ActivityEvent[];
}

// ─── Tunables — feel free to bump in one place. ─────────────────────
const STUCK_RECLASS_IN_REVIEW_DAYS = 14;
const STUCK_RECLASS_WEB_PAUSED_HOURS = 24;
const STUCK_COA_IN_REVIEW_DAYS = 7;
const STUCK_HARDCORE_REVIEW_DAYS = 14;
const STUCK_SENIOR_REVIEW_DAYS = 5;
const QBO_TOKEN_STALE_DAYS = 14; // last refresh >14d ago = likely refresh-token issue
const STRIPE_LINK_NO_RESPONSE_DAYS = 7;
const BANK_RULES_UNEXPORTED_DAYS = 7;
const ONBOARDING_STALLED_DAYS = 60;
const NO_RECENT_ACTIVITY_DAYS = 45;
const RECENT_FAILURE_WINDOW_DAYS = 90;
const ACTIVITY_FEED_LIMIT = 30;

function daysSince(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}
function hoursSince(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.floor((Date.now() - t) / 3_600_000);
}
function isoNDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
function isoNHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/**
 * Filter options. Passed straight through from /api/fleet/health
 * query params so the URL is bookmarkable.
 */
export interface FleetFilters {
  /** Limit to one bookkeeper's portfolio. */
  bookkeeperId?: string | null;
  /** Limit to one severity bucket. */
  severity?: Severity | null;
  /** Free-text search across client_name / error_message / detail. */
  search?: string | null;
}

export async function buildFleetSnapshot(
  service: SupabaseClient<any, any, any>,
  filters: FleetFilters = {}
): Promise<FleetSnapshot> {
  // Pull active clients + bookkeepers up front so every panel can
  // attach FleetClient details without N+1 joins. Inactive + completed
  // clients drop out — they don't belong on a fleet *health* view.
  const [clientsRes, bookkeepersRes] = await Promise.all([
    service
      .from("client_links")
      .select(
        "id, client_name, assigned_bookkeeper_id, jurisdiction, is_active, cleanup_completed_at, stripe_request_sent_at, stripe_connection_status, stripe_not_required, qbo_realm_id, qbo_token_expires_at, double_client_id, last_synced_at, created_at, kanban_on_hold"
      )
      .eq("is_active", true),
    service.from("users").select("id, full_name").eq("is_active", true),
  ]);

  const allClients = (clientsRes.data as any[]) || [];
  const bookkeepers = (bookkeepersRes.data as any[]) || [];
  const bkById = new Map<string, string>();
  for (const u of bookkeepers) bkById.set(u.id, u.full_name);

  function toFleetClient(c: any): FleetClient {
    return {
      id: c.id,
      name: c.client_name,
      bookkeeper_id: c.assigned_bookkeeper_id,
      bookkeeper_name: c.assigned_bookkeeper_id
        ? bkById.get(c.assigned_bookkeeper_id) ?? null
        : null,
      jurisdiction: c.jurisdiction || null,
    };
  }
  const clientById = new Map<string, any>();
  for (const c of allClients) clientById.set(c.id, c);

  // Active dismissals — items we should suppress from the dashboard.
  const dismissalsRes: any = await (service as any)
    .from("fleet_dismissals")
    .select("item_type, item_id, expires_at")
    .or("expires_at.is.null,expires_at.gt." + new Date().toISOString());
  const dismissed = new Set<string>(
    ((dismissalsRes.data as any[]) || []).map(
      (d: any) => `${d.item_type}:${d.item_id}`
    )
  );
  const notDismissed = (kind: string, id: string) =>
    !dismissed.has(`${kind}:${id}`);

  // ── Fan out every panel query in parallel. ──
  const failureWindowIso = isoNDaysAgo(RECENT_FAILURE_WINDOW_DAYS);
  const [
    reclassFailed,
    coaFailed,
    hardcoreFailed,
    stripeReconFailed,
    reclassInReview,
    reclassPaused,
    coaInReview,
    hardcoreInReview,
    seniorReviewPending,
    bankRulesUnexported,
    auditFeed,
    momLastMonth,
  ] = await Promise.all([
    service
      .from("reclass_jobs")
      .select("id, client_link_id, status, error_message, updated_at, created_at")
      .eq("status", "failed")
      .gt("updated_at", failureWindowIso),
    service
      .from("coa_jobs")
      .select(
        "id, client_link_id, status, error_message, updated_at, created_at"
      )
      .eq("status", "failed")
      .gt("updated_at", failureWindowIso),
    (service as any)
      .from("hardcore_cleanup_runs")
      .select("id, client_link_id, status, error_message, created_at, finalized_at")
      .eq("status", "failed")
      .gt("created_at", failureWindowIso),
    (service as any)
      .from("stripe_recon_jobs")
      .select("id, client_link_id, status, error_message, created_at")
      .eq("status", "failed")
      .gt("created_at", failureWindowIso),
    service
      .from("reclass_jobs")
      .select("id, client_link_id, status, created_at, target_account_name")
      .eq("status", "in_review")
      .lt("created_at", isoNDaysAgo(STUCK_RECLASS_IN_REVIEW_DAYS)),
    service
      .from("reclass_jobs")
      .select("id, client_link_id, status, updated_at")
      .eq("status", "web_search_paused" as any)
      .lt("updated_at", isoNHoursAgo(STUCK_RECLASS_WEB_PAUSED_HOURS)),
    service
      .from("coa_jobs")
      .select("id, client_link_id, status, created_at")
      .eq("status", "in_review")
      .lt("created_at", isoNDaysAgo(STUCK_COA_IN_REVIEW_DAYS)),
    (service as any)
      .from("hardcore_cleanup_runs")
      .select("id, client_link_id, status, created_at")
      .eq("status", "review")
      .lt("created_at", isoNDaysAgo(STUCK_HARDCORE_REVIEW_DAYS)),
    service
      .from("client_links")
      .select(
        "id, client_name, cleanup_review_state, cleanup_review_submitted_at"
      )
      .eq("cleanup_review_state", "in_review")
      .lt("cleanup_review_submitted_at", isoNDaysAgo(STUCK_SENIOR_REVIEW_DAYS)),
    service
      .from("bank_rules")
      .select("id, client_link_id, vendor_pattern, pushed_to_qbo, created_at")
      .eq("pushed_to_qbo", false)
      .lt("created_at", isoNDaysAgo(BANK_RULES_UNEXPORTED_DAYS)),
    service
      .from("audit_log")
      .select(
        "occurred_at, event_type, user_id, request_payload"
      )
      .order("occurred_at", { ascending: false })
      .limit(ACTIVITY_FEED_LIMIT * 2),
    // Detect MoM-not-closed: reclass_jobs where workflow=full_categorization
    // and month_closed_at IS NULL and target_month is older than 1 month ago.
    service
      .from("reclass_jobs")
      .select("id, client_link_id, target_month, month_closed_at, workflow")
      .eq("workflow", "full_categorization")
      .is("month_closed_at", null)
      .lt("target_month", isoNDaysAgo(40).slice(0, 10)),
  ]);

  // ── Panel A — Job failures ──
  const panelA: FailedJob[] = [];
  function pushFailure(
    kind: FailedJob["kind"],
    row: any,
    failedAtField: string = "updated_at"
  ) {
    const c = clientById.get(row.client_link_id);
    if (!c) return;
    if (!notDismissed(`failed_${kind}`, row.id)) return;
    const failedAt = row[failedAtField] || row.created_at;
    panelA.push({
      client: toFleetClient(c),
      kind,
      job_id: row.id,
      failed_at: failedAt,
      age_hours: hoursSince(failedAt),
      error_message: (row.error_message || "(no error message)").slice(0, 300),
      dollars_at_risk: null,
    });
  }
  for (const r of (reclassFailed.data as any[]) || []) pushFailure("reclass", r);
  for (const r of (coaFailed.data as any[]) || []) pushFailure("coa", r);
  for (const r of ((hardcoreFailed as any).data as any[]) || [])
    pushFailure("hardcore_cleanup", r, "created_at");
  for (const r of ((stripeReconFailed as any).data as any[]) || [])
    pushFailure("stripe_recon", r, "created_at");
  panelA.sort((a, b) => b.age_hours - a.age_hours);

  // ── Panel B — Stuck workflows ──
  const panelB: StuckItem[] = [];
  function pushStuck(
    kind: StuckItem["kind"],
    referenceId: string,
    clientId: string,
    startedAt: string,
    detail: string,
    dollarsAtRisk: number | null = null
  ) {
    const c = clientById.get(clientId);
    if (!c) return;
    if (!notDismissed(`stuck_${kind}`, referenceId)) return;
    panelB.push({
      client: toFleetClient(c),
      kind,
      reference_id: referenceId,
      started_at: startedAt,
      age_days: daysSince(startedAt),
      detail,
      dollars_at_risk: dollarsAtRisk,
    });
  }
  for (const r of (reclassInReview.data as any[]) || [])
    pushStuck(
      "reclass_in_review",
      r.id,
      r.client_link_id,
      r.created_at,
      `Reclass${r.target_account_name ? ` (${r.target_account_name})` : ""} in_review`
    );
  for (const r of (reclassPaused.data as any[]) || [])
    pushStuck(
      "reclass_web_search_paused",
      r.id,
      r.client_link_id,
      r.updated_at,
      "Reclass paused awaiting web-search resume / skip"
    );
  for (const r of (coaInReview.data as any[]) || [])
    pushStuck("coa_in_review", r.id, r.client_link_id, r.created_at, "COA cleanup in_review");
  for (const r of ((hardcoreInReview as any).data as any[]) || [])
    pushStuck(
      "hardcore_cleanup_review",
      r.id,
      r.client_link_id,
      r.created_at,
      "Hardcore BS Cleanup run not finalized"
    );
  for (const r of (seniorReviewPending.data as any[]) || [])
    pushStuck(
      "senior_review_pending",
      r.id,
      r.id,
      r.cleanup_review_submitted_at,
      "Awaiting Lisa's senior review"
    );
  for (const r of (momLastMonth.data as any[]) || [])
    pushStuck(
      "mom_not_closed",
      r.id,
      r.client_link_id,
      r.target_month,
      `MoM ${r.target_month?.slice(0, 7)} not yet closed`
    );
  panelB.sort((a, b) => b.age_days - a.age_days);

  // ── Panel C — Integration health ──
  const panelC: IntegrationIssue[] = [];
  const tokenStaleCutoff = Date.now() - QBO_TOKEN_STALE_DAYS * 86_400_000;
  for (const c of allClients) {
    if (c.qbo_realm_id) {
      const exp = c.qbo_token_expires_at
        ? Date.parse(c.qbo_token_expires_at)
        : null;
      if (exp !== null && Number.isFinite(exp)) {
        if (exp < Date.now()) {
          if (notDismissed("integration_qbo_token_expired", c.id)) {
            panelC.push({
              client: toFleetClient(c),
              kind: "qbo_token_expired",
              detail: `QBO access token expired ${daysSince(c.qbo_token_expires_at)}d ago — refresh likely failing.`,
              age_days: daysSince(c.qbo_token_expires_at),
              recommended_action: "Reconnect QBO from client profile",
            });
          }
        } else if (exp < tokenStaleCutoff) {
          if (notDismissed("integration_qbo_token_stale", c.id)) {
            panelC.push({
              client: toFleetClient(c),
              kind: "qbo_token_stale",
              detail: `QBO access token last refreshed ${daysSince(c.qbo_token_expires_at)}d ago. Refresh token may be expiring.`,
              age_days: daysSince(c.qbo_token_expires_at),
              recommended_action: "Trigger a refresh — run any QBO fetch",
            });
          }
        }
      }
    }
    // Stripe link sent + no response
    if (
      c.stripe_request_sent_at &&
      c.stripe_connection_status !== "connected" &&
      !c.stripe_not_required &&
      daysSince(c.stripe_request_sent_at) > STRIPE_LINK_NO_RESPONSE_DAYS
    ) {
      if (notDismissed("integration_stripe_link", c.id)) {
        panelC.push({
          client: toFleetClient(c),
          kind: "stripe_link_no_response",
          detail: `Stripe Connect link sent ${daysSince(c.stripe_request_sent_at)}d ago, client hasn't completed.`,
          age_days: daysSince(c.stripe_request_sent_at),
          recommended_action: "Resend Stripe link or mark not-required",
        });
      }
    }
    // Double unmatched
    if (
      (!c.double_client_id ||
        String(c.double_client_id).startsWith("pending_")) &&
      daysSince(c.created_at) > 30
    ) {
      if (notDismissed("integration_double_unmatched", c.id)) {
        panelC.push({
          client: toFleetClient(c),
          kind: "double_unmatched",
          detail: `Client created ${daysSince(c.created_at)}d ago, Double match still pending.`,
          age_days: daysSince(c.created_at),
          recommended_action: "Match in Double settings",
        });
      }
    }
  }
  // Bank rules waiting for export — group per client
  const rulesPerClient = new Map<string, { count: number; oldest: string }>();
  for (const r of (bankRulesUnexported.data as any[]) || []) {
    const cur = rulesPerClient.get(r.client_link_id) || {
      count: 0,
      oldest: r.created_at,
    };
    cur.count += 1;
    if (r.created_at < cur.oldest) cur.oldest = r.created_at;
    rulesPerClient.set(r.client_link_id, cur);
  }
  for (const [cid, info] of rulesPerClient.entries()) {
    const c = clientById.get(cid);
    if (!c) continue;
    if (!notDismissed("integration_bank_rules_unexported", cid)) continue;
    panelC.push({
      client: toFleetClient(c),
      kind: "bank_rules_unexported",
      detail: `${info.count} bank rule${info.count === 1 ? "" : "s"} not yet exported to QBO (oldest ${daysSince(info.oldest)}d).`,
      age_days: daysSince(info.oldest),
      recommended_action: "Download .xls + import in QBO",
    });
  }
  panelC.sort((a, b) => b.age_days - a.age_days);

  // ── Panel D — Pipeline drift ──
  const panelD: DriftItem[] = [];
  for (const c of allClients) {
    if (
      !c.cleanup_completed_at &&
      daysSince(c.created_at) > ONBOARDING_STALLED_DAYS
    ) {
      if (notDismissed("drift_onboarding_stalled", c.id)) {
        panelD.push({
          client: toFleetClient(c),
          kind: "onboarding_stalled",
          detail: `Onboarded ${daysSince(c.created_at)}d ago but cleanup not yet complete.`,
          age_days: daysSince(c.created_at),
        });
      }
    }
    if (
      c.last_synced_at &&
      daysSince(c.last_synced_at) > NO_RECENT_ACTIVITY_DAYS
    ) {
      if (notDismissed("drift_no_activity", c.id)) {
        panelD.push({
          client: toFleetClient(c),
          kind: "no_recent_activity",
          detail: `No QBO sync in ${daysSince(c.last_synced_at)}d.`,
          age_days: daysSince(c.last_synced_at),
        });
      }
    }
  }
  panelD.sort((a, b) => b.age_days - a.age_days);

  // ── Panel E — Bookkeeper workload ──
  const loadByBk = new Map<string, BookkeeperLoad>();
  for (const u of bookkeepers) {
    loadByBk.set(u.id, {
      bookkeeper_id: u.id,
      bookkeeper_name: u.full_name,
      active_clients: 0,
      open_jobs: 0,
      failing_jobs: 0,
      last_activity: null,
    });
  }
  for (const c of allClients) {
    if (!c.assigned_bookkeeper_id) continue;
    const bk = loadByBk.get(c.assigned_bookkeeper_id);
    if (bk) bk.active_clients++;
  }
  for (const f of panelA) {
    if (!f.client.bookkeeper_id) continue;
    const bk = loadByBk.get(f.client.bookkeeper_id);
    if (bk) {
      bk.failing_jobs++;
      bk.open_jobs++;
    }
  }
  for (const s of panelB) {
    if (!s.client.bookkeeper_id) continue;
    const bk = loadByBk.get(s.client.bookkeeper_id);
    if (bk) bk.open_jobs++;
  }
  const panelE = Array.from(loadByBk.values())
    .filter((b) => b.active_clients > 0)
    .sort((a, b) => b.open_jobs - a.open_jobs || b.active_clients - a.active_clients);

  // ── Activity feed ──
  const feedRowsRaw = (auditFeed.data as any[]) || [];
  const userNameById = new Map<string, string>();
  for (const u of bookkeepers) userNameById.set(u.id, u.full_name);
  const activity_feed: ActivityEvent[] = feedRowsRaw
    .slice(0, ACTIVITY_FEED_LIMIT)
    .map((r) => {
      const payload = (r.request_payload || {}) as any;
      const clientLinkId =
        payload.client_link_id || payload.client_id || null;
      const c = clientLinkId ? clientById.get(clientLinkId) : null;
      return {
        occurred_at: r.occurred_at,
        event_type: r.event_type,
        user_name: r.user_id ? userNameById.get(r.user_id) ?? null : null,
        client_link_id: clientLinkId,
        client_name: c?.client_name || payload.client_name || null,
        summary: summarizeAuditEvent(r.event_type, payload),
      };
    });

  // ── Header strip rollup ──
  const clientHealth = new Map<string, Severity>();
  for (const c of allClients) clientHealth.set(c.id, "healthy");
  for (const f of panelA) clientHealth.set(f.client.id, "failing");
  for (const s of panelB) {
    if (clientHealth.get(s.client.id) !== "failing")
      clientHealth.set(s.client.id, "warning");
  }
  for (const i of panelC) {
    const cur = clientHealth.get(i.client.id);
    if (i.kind === "qbo_token_expired") clientHealth.set(i.client.id, "failing");
    else if (cur === "healthy") clientHealth.set(i.client.id, "warning");
  }
  for (const d of panelD) {
    if (clientHealth.get(d.client.id) === "healthy")
      clientHealth.set(d.client.id, "warning");
  }
  let healthy = 0,
    warning = 0,
    failing = 0;
  for (const sev of clientHealth.values()) {
    if (sev === "healthy") healthy++;
    else if (sev === "warning") warning++;
    else failing++;
  }
  const totalDollarsAtRisk = [...panelA, ...panelB].reduce(
    (s, x: any) => s + (x.dollars_at_risk || 0),
    0
  );

  // ── Apply filters (post-build for simplicity; data set is small) ──
  let snapshot: FleetSnapshot = {
    generated_at: new Date().toISOString(),
    total_clients: allClients.length,
    healthy,
    warning,
    failing,
    total_dollars_at_risk: totalDollarsAtRisk,
    panel_a_job_failures: panelA,
    panel_b_stuck_workflows: panelB,
    panel_c_integration_health: panelC,
    panel_d_pipeline_drift: panelD,
    panel_e_bookkeeper_workload: panelE,
    activity_feed,
  };
  if (filters.bookkeeperId) {
    const id = filters.bookkeeperId;
    const keepClient = (cl: FleetClient) => cl.bookkeeper_id === id;
    snapshot = {
      ...snapshot,
      panel_a_job_failures: panelA.filter((x) => keepClient(x.client)),
      panel_b_stuck_workflows: panelB.filter((x) => keepClient(x.client)),
      panel_c_integration_health: panelC.filter((x) => keepClient(x.client)),
      panel_d_pipeline_drift: panelD.filter((x) => keepClient(x.client)),
      panel_e_bookkeeper_workload: panelE.filter((b) => b.bookkeeper_id === id),
    };
  }
  if (filters.severity === "failing") {
    snapshot = {
      ...snapshot,
      panel_b_stuck_workflows: [],
      panel_c_integration_health: snapshot.panel_c_integration_health.filter(
        (i) => i.kind === "qbo_token_expired"
      ),
      panel_d_pipeline_drift: [],
    };
  } else if (filters.severity === "warning") {
    snapshot = { ...snapshot, panel_a_job_failures: [] };
  }
  if (filters.search) {
    const s = filters.search.toLowerCase();
    const matchClient = (c: FleetClient) =>
      c.name.toLowerCase().includes(s) ||
      (c.bookkeeper_name || "").toLowerCase().includes(s);
    snapshot = {
      ...snapshot,
      panel_a_job_failures: snapshot.panel_a_job_failures.filter(
        (x) => matchClient(x.client) || x.error_message.toLowerCase().includes(s)
      ),
      panel_b_stuck_workflows: snapshot.panel_b_stuck_workflows.filter(
        (x) => matchClient(x.client) || x.detail.toLowerCase().includes(s)
      ),
      panel_c_integration_health: snapshot.panel_c_integration_health.filter(
        (x) => matchClient(x.client) || x.detail.toLowerCase().includes(s)
      ),
      panel_d_pipeline_drift: snapshot.panel_d_pipeline_drift.filter(
        (x) => matchClient(x.client) || x.detail.toLowerCase().includes(s)
      ),
    };
  }

  return snapshot;
}

function summarizeAuditEvent(
  eventType: string,
  payload: any
): string {
  const name = payload?.client_name || payload?.client_link_id || "client";
  switch (eventType) {
    case "client_update":
      return `Updated ${name}`;
    case "client_delete":
      return `Deleted ${name}`;
    case "client_cleanup_completed":
      return `Marked ${name} cleanup complete`;
    case "client_cleanup_reopened":
      return `Reopened cleanup for ${name}`;
    case "stripe_invite_dismissed":
      return `Dismissed Stripe invite for ${name}`;
    case "qbo_create_missing_parent":
      return `Created missing COA parent for ${name}`;
    case "job_start":
    case "job_complete":
    case "job_failed":
      return `${eventType.replace(/_/g, " ")} on ${name}`;
    default:
      return `${eventType.replace(/_/g, " ")}${name ? ` — ${name}` : ""}`;
  }
}
