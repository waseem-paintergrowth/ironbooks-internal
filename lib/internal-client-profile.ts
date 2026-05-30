/**
 * Internal client profile data layer.
 *
 * Queries SNAP-side tables (not QBO) for state that bookkeepers care
 * about: outstanding work, recent activity, summary stats. QBO financial
 * data is handled separately by lib/portal-data.ts which is reused
 * verbatim by the financial tabs on /clients/[id].
 *
 * All functions take a service-role Supabase client + client_link_id so
 * they're callable from any server component without RLS surprises.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ─── OUTSTANDING WORK ───────────────────────────────────────────────────

/** A single piece of work the bookkeeper still owes this client. */
export interface OutstandingItem {
  /** Stable category — drives the icon/color in the UI. */
  category:
    | "reclass_in_review"
    | "reclass_failed"
    | "coa_in_review"
    | "coa_failed"
    | "bank_rules_pending"
    | "hardcore_cleanup_open"
    | "uf_audit_open"
    | "ar_recovery_open";
  /** Short label rendered as the card title. */
  label: string;
  /** How many items / why it's outstanding. */
  detail: string;
  /** Where clicking the card takes the bookkeeper. */
  href: string;
  /** When this item was created/last touched — drives sort order so the
   *  freshest issues bubble up. */
  occurredAt: string | null;
}

export interface OutstandingWork {
  items: OutstandingItem[];
  totalCount: number;
}

/**
 * Scan SNAP's job/queue tables for anything that needs the bookkeeper's
 * attention on this client. Returns sorted-newest-first so the top of
 * the list is the freshest fire.
 */
export async function fetchOutstandingWork(
  service: SupabaseClient,
  clientLinkId: string
): Promise<OutstandingWork> {
  const items: OutstandingItem[] = [];

  // Reclass jobs in review or failed. "in_review" means discovery finished
  // and is waiting on the bookkeeper to approve/reject. "failed" means
  // execution errored out — needs investigation.
  const { data: reclassJobs } = await service
    .from("reclass_jobs")
    .select("id, status, workflow, source_account_name, date_range_start, date_range_end, ai_completed_at, created_at")
    .eq("client_link_id", clientLinkId)
    .in("status", ["in_review", "web_search_paused", "failed"])
    .order("created_at", { ascending: false });

  for (const j of (reclassJobs || []) as any[]) {
    const isFailed = j.status === "failed";
    items.push({
      category: isFailed ? "reclass_failed" : "reclass_in_review",
      label: isFailed ? "Reclass job failed" : "Reclass awaiting review",
      detail: `${j.workflow || "reclass"} · ${j.source_account_name || "all accounts"} · ${j.date_range_start || "?"} → ${j.date_range_end || "?"}`,
      href: `/reclass/${j.id}/review`,
      occurredAt: j.ai_completed_at || j.created_at,
    });
  }

  // COA cleanup jobs same pattern.
  const { data: coaJobs } = await service
    .from("coa_jobs")
    .select("id, status, created_at, error_message")
    .eq("client_link_id", clientLinkId)
    .in("status", ["in_review", "failed"])
    .order("created_at", { ascending: false });

  for (const j of (coaJobs || []) as any[]) {
    const isFailed = j.status === "failed";
    items.push({
      category: isFailed ? "coa_failed" : "coa_in_review",
      label: isFailed ? "COA cleanup failed" : "COA cleanup awaiting review",
      detail: isFailed
        ? (j.error_message || "Check job for details").slice(0, 120)
        : "Bookkeeper review pending",
      href: `/jobs/${j.id}/review`,
      occurredAt: j.created_at,
    });
  }

  // Pending bank rules (discovered but bookkeeper hasn't approved yet).
  // Grouped so we don't spam the list with 30 individual rules.
  const { count: pendingRulesCount } = await service
    .from("bank_rules")
    .select("id", { count: "exact", head: true })
    .eq("client_link_id", clientLinkId)
    .eq("status", "pending");

  if (pendingRulesCount && pendingRulesCount > 0) {
    // Find the most-recent discovery job so we link to the right review page.
    const { data: latestJob } = await service
      .from("rule_discovery_jobs")
      .select("id, created_at")
      .eq("client_link_id", clientLinkId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    items.push({
      category: "bank_rules_pending",
      label: `${pendingRulesCount} bank rule${pendingRulesCount === 1 ? "" : "s"} pending approval`,
      detail: "Review and activate or reject",
      href: latestJob ? `/rules/${(latestJob as any).id}/review` : "/clients",
      occurredAt: (latestJob as any)?.created_at || null,
    });
  }

  // Hardcore BS cleanup runs that aren't done. Status field varies — we
  // treat anything not 'complete' or 'cancelled' as still open. Wrapped
  // in try/catch because this table may not exist on older deploys.
  try {
    const { data: hardcoreRuns } = await service
      .from("hardcore_cleanup_runs")
      .select("id, status, created_at")
      .eq("client_link_id", clientLinkId)
      .not("status", "in", "(complete,cancelled)")
      .order("created_at", { ascending: false });

    for (const r of (hardcoreRuns || []) as any[]) {
      items.push({
        category: "hardcore_cleanup_open",
        label: "Hardcore BS cleanup in progress",
        detail: `Status: ${r.status || "running"}`,
        href: `/balance-sheet/${clientLinkId}/hardcore-cleanup`,
        occurredAt: r.created_at,
      });
    }
  } catch {
    // hardcore_cleanup_runs missing → migration 41 not yet applied. Ignore.
  }

  // UF audit + A/R recovery jobs — both tables may or may not exist
  // depending on what's deployed. Best-effort, never throw.
  try {
    const { data: ufAudits } = await service
      .from("uf_audit_runs")
      .select("id, status, created_at")
      .eq("client_link_id", clientLinkId)
      .not("status", "in", "(complete,cancelled,finalized)")
      .order("created_at", { ascending: false });

    for (const a of (ufAudits || []) as any[]) {
      items.push({
        category: "uf_audit_open",
        label: "UF audit in progress",
        detail: `Status: ${a.status || "running"}`,
        href: `/balance-sheet/${clientLinkId}/uf-audit`,
        occurredAt: a.created_at,
      });
    }
  } catch {
    /* table not present */
  }

  try {
    const { data: arJobs } = await service
      .from("uncat_income_jobs")
      .select("id, status, created_at")
      .eq("client_link_id", clientLinkId)
      .not("status", "in", "(complete,cancelled,finalized)")
      .order("created_at", { ascending: false });

    for (const a of (arJobs || []) as any[]) {
      items.push({
        category: "ar_recovery_open",
        label: "A/R recovery in progress",
        detail: `Status: ${a.status || "running"}`,
        href: `/ar-recovery/${a.id}/review`,
        occurredAt: a.created_at,
      });
    }
  } catch {
    /* table not present */
  }

  // Sort newest-first so the freshest fires are at the top.
  items.sort((a, b) => {
    const ta = a.occurredAt ? Date.parse(a.occurredAt) : 0;
    const tb = b.occurredAt ? Date.parse(b.occurredAt) : 0;
    return tb - ta;
  });

  return { items, totalCount: items.length };
}

// ─── RECENT ACTIVITY ────────────────────────────────────────────────────

export interface ActivityEvent {
  id: string;
  eventType: string;
  occurredAt: string;
  /** Best-effort human label derived from event_type. */
  label: string;
  /** Where to jump for context (null if we can't infer). */
  href: string | null;
  payload: any;
}

/**
 * Last N audit_log entries scoped to this client. We have no FK from
 * audit_log → client_link_id, so we filter on request_payload->>client_link_id
 * (or fields like reclass_job_id that resolve back to this client). This
 * is best-effort — some events won't carry the client ID and will be missed,
 * but the ones we do surface are the bookkeeper-meaningful ones.
 */
export async function fetchRecentActivity(
  service: SupabaseClient,
  clientLinkId: string,
  limit = 25
): Promise<ActivityEvent[]> {
  const { data } = await service
    .from("audit_log")
    .select("id, event_type, occurred_at, request_payload")
    .filter("request_payload->>client_link_id", "eq", clientLinkId)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  return ((data || []) as any[]).map((row) => ({
    id: row.id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    label: humanizeEventType(row.event_type),
    href: inferActivityHref(row.event_type, row.request_payload, clientLinkId),
    payload: row.request_payload,
  }));
}

function humanizeEventType(t: string): string {
  // event_type values are snake_case. Split + title-case for display.
  if (!t) return "Activity";
  return t
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferActivityHref(
  eventType: string,
  payload: any,
  clientLinkId: string
): string | null {
  if (!payload) return null;
  if (payload.reclass_job_id) return `/reclass/${payload.reclass_job_id}/review`;
  if (payload.coa_job_id) return `/jobs/${payload.coa_job_id}/review`;
  if (payload.discovery_job_id) return `/rules/${payload.discovery_job_id}/review`;
  if (eventType.includes("bank_rules") || eventType.includes("rule_")) {
    return `/clients/${clientLinkId}`; // landing here is fine if no specific job
  }
  return null;
}

// ─── INTERNAL SUMMARY STATS ────────────────────────────────────────────

export interface InternalSummary {
  /** Total bank_rules with status='active'. */
  activeBankRules: number;
  /** Most recent pushed_to_qbo_at across all rules — when this client's
   *  rule library was last exported to QBO. Null if never exported. */
  lastRuleExportAt: string | null;
  /** Last 5 completed reclass jobs for the activity strip. */
  recentReclassJobs: Array<{
    id: string;
    status: string;
    workflow: string | null;
    createdAt: string;
    sourceAccountName: string | null;
  }>;
  /** Last 5 completed COA cleanups. */
  recentCleanups: Array<{
    id: string;
    status: string;
    createdAt: string;
  }>;
}

export async function fetchInternalSummary(
  service: SupabaseClient,
  clientLinkId: string
): Promise<InternalSummary> {
  const [rulesCount, lastExport, reclassJobs, coaJobs] = await Promise.all([
    service
      .from("bank_rules")
      .select("id", { count: "exact", head: true })
      .eq("client_link_id", clientLinkId)
      .eq("status", "active"),
    service
      .from("bank_rules")
      .select("pushed_to_qbo_at")
      .eq("client_link_id", clientLinkId)
      .not("pushed_to_qbo_at", "is", null)
      .order("pushed_to_qbo_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    service
      .from("reclass_jobs")
      .select("id, status, workflow, created_at, source_account_name")
      .eq("client_link_id", clientLinkId)
      .order("created_at", { ascending: false })
      .limit(5),
    service
      .from("coa_jobs")
      .select("id, status, created_at")
      .eq("client_link_id", clientLinkId)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  return {
    activeBankRules: rulesCount.count ?? 0,
    lastRuleExportAt: (lastExport.data as any)?.pushed_to_qbo_at ?? null,
    recentReclassJobs: ((reclassJobs.data || []) as any[]).map((r) => ({
      id: r.id,
      status: r.status,
      workflow: r.workflow,
      createdAt: r.created_at,
      sourceAccountName: r.source_account_name,
    })),
    recentCleanups: ((coaJobs.data || []) as any[]).map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.created_at,
    })),
  };
}
