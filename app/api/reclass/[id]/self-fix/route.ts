import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/reclass/[id]/self-fix
 *
 * One-click "get unstuck" for a reclass job. Diagnoses the job's status and
 * applies the safe, forward-moving recovery — so a bookkeeper doesn't have to
 * know which of skip / continue / retry the situation needs.
 *
 *   web_search_paused → skip the vendor web-search → in_review   (instant)
 *   ai_paused         → resume: open the job, the chunk runner continues
 *   executing (stale) → reset to failed so the job page offers a retry (instant)
 *   executing (fresh) → leave it — it's genuinely still working
 *   failed            → open the job to retry / start fresh
 *   else              → nothing to fix
 *
 * Returns { fixed, message, href, status }. Owner or senior only.
 */

// Match the watchdog: a run that hasn't moved in this long is considered hung.
const STALE_MS = 20 * 60 * 1000;

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: job } = await service
    .from("reclass_jobs")
    .select("id, status, bookkeeper_id, execution_started_at, updated_at")
    .eq("id", jobId)
    .single();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const { data: actor } = await service
    .from("users").select("role").eq("id", user.id).single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role ?? "");
  const isOwner = (job as any).bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const href = `/reclass/${jobId}/review`;
  const status = (job as any).status as string;
  const log = (action: string, fixed: boolean) =>
    service.from("audit_log").insert({
      user_id: user.id,
      event_type: "reclass_self_fix",
      request_payload: { job_id: jobId, from_status: status, action, fixed } as any,
    }).then(() => {}, () => {});

  // 1) Vendor web-search pause → skip straight to review (data already valid).
  if (status === "web_search_paused") {
    await service.from("reclass_jobs")
      .update({ status: "in_review", error_message: null } as any)
      .eq("id", jobId);
    await log("skip_web_search", true);
    return NextResponse.json({
      fixed: true, status: "in_review", href,
      message: "Skipped the vendor web-search step — the job is now ready to review.",
    });
  }

  // 2) Chunked-AI pause → can't safely skip (would leave lines uncategorized).
  //    Send them to the job, where the chunk runner resumes the categorization.
  if (status === "ai_paused") {
    await log("resume_ai", false);
    return NextResponse.json({
      fixed: false, status, href, navigate: true,
      message: "Categorization is paused between batches. Opening the job to continue it.",
    });
  }

  // 3) Executing → only reset if it's genuinely hung (past the watchdog window).
  if (status === "executing") {
    const last = (job as any).execution_started_at || (job as any).updated_at;
    const ageMs = last ? Date.now() - new Date(last).getTime() : Infinity;
    if (ageMs > STALE_MS) {
      await service.from("reclass_jobs")
        .update({
          status: "failed",
          error_message: "Reset by Get-unstuck: run was hung with no progress. Retry or start fresh.",
        } as any)
        .eq("id", jobId);
      await log("reset_stale", true);
      return NextResponse.json({
        fixed: true, status: "failed", href, navigate: true,
        message: "This run was stuck and has been reset — open the job to retry.",
      });
    }
    await log("still_running", false);
    const mins = Math.max(1, Math.round(ageMs / 60000));
    return NextResponse.json({
      fixed: false, status, href,
      message: `Still running (~${mins} min in). Give it a few minutes before resetting.`,
    });
  }

  // 4) Failed → the job page has the retry / start-fresh controls.
  if (status === "failed") {
    await log("open_failed", false);
    return NextResponse.json({
      fixed: false, status, href, navigate: true,
      message: "This job failed earlier. Opening it so you can retry or start fresh.",
    });
  }

  // 5) Anything else isn't stuck.
  await log("noop", false);
  return NextResponse.json({
    fixed: false, status, href,
    message: `Nothing to fix — this job isn't stuck (status: ${status}).`,
  });
}
