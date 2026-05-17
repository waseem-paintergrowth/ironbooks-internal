import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { after } from "next/server";
import {
  reclassifyTransactionLines,
  buildAuditMemo,
  getValidToken,
  type SupportedTxType,
} from "@/lib/qbo-reclass";

/**
 * POST /api/reclass/[id]/rollback
 *
 * LAST RESORT. Reverses an executed reclass job by moving transactions back
 * to their original accounts.
 *
 * Body: { confirmation_phrase: "ROLLBACK" }  — typed by bookkeeper to confirm
 *
 * Creates a new reclass_job marked as is_rollback=true, parent_job_id=original.
 * Runs in background.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: originalJobId } = await context.params;
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Require admin or lead role for rollback
  const { data: actor } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!actor || !["admin", "lead"].includes(actor.role)) {
    return NextResponse.json({ error: "Only admins or leads can roll back" }, { status: 403 });
  }

  const body = await request.json();
  if (body.confirmation_phrase !== "ROLLBACK") {
    return NextResponse.json(
      { error: 'You must type "ROLLBACK" in confirmation_phrase to proceed' },
      { status: 400 }
    );
  }

  const service = createServiceSupabase();

  const { data: originalJob } = await service
    .from("reclass_jobs")
    .select("*")
    .eq("id", originalJobId)
    .single();
  if (!originalJob) return NextResponse.json({ error: "Original job not found" }, { status: 404 });
  if (originalJob.status !== "complete") {
    return NextResponse.json(
      { error: "Can only roll back completed jobs" },
      { status: 400 }
    );
  }
  if (originalJob.rolled_back) {
    return NextResponse.json({ error: "Already rolled back" }, { status: 400 });
  }
  if (originalJob.is_rollback) {
    return NextResponse.json(
      { error: "Cannot roll back a rollback job" },
      { status: 400 }
    );
  }

  // Create the inverse job
  const { data: rollbackJob, error } = await service
    .from("reclass_jobs")
    .insert({
      client_link_id: originalJob.client_link_id,
      bookkeeper_id: user.id,
      workflow: originalJob.workflow,
      status: "executing",
      // Inverse: source becomes original target, target becomes original source
      source_account_id: originalJob.target_account_id || originalJob.source_account_id,
      source_account_name: originalJob.target_account_name || originalJob.source_account_name,
      target_account_id: originalJob.source_account_id,
      target_account_name: originalJob.source_account_name,
      date_range_start: originalJob.date_range_start,
      date_range_end: originalJob.date_range_end,
      jurisdiction: originalJob.jurisdiction,
      state_province: originalJob.state_province,
      reason: `ROLLBACK of job ${originalJobId}: ${originalJob.reason}`,
      is_rollback: true,
      parent_job_id: originalJobId,
      attested: true, // pre-attested because admin/lead initiated
      attested_at: new Date().toISOString(),
      execution_started_at: new Date().toISOString(),
    } as any)
    .select()
    .single();

  if (error || !rollbackJob) {
    return NextResponse.json({ error: error?.message || "Failed to create rollback job" }, { status: 500 });
  }

  // Schedule background rollback work
  after(async () => {
    try {
      await runRollback(rollbackJob.id, originalJobId, user.id);
    } catch (err: any) {
      console.error(`Rollback failed for ${rollbackJob.id}:`, err);
      const svc = createServiceSupabase();
      await svc
        .from("reclass_jobs")
        .update({
          status: "failed",
          error_message: err.message,
          execution_completed_at: new Date().toISOString(),
        } as any)
        .eq("id", rollbackJob.id);
    }
  });

  return NextResponse.json({
    started: true,
    rollback_job_id: rollbackJob.id,
    original_job_id: originalJobId,
  });
}

async function runRollback(
  rollbackJobId: string,
  originalJobId: string,
  initiatingUserId: string
) {
  const service = createServiceSupabase();
  const startTime = Date.now();

  const { data: rollbackJob } = await service
    .from("reclass_jobs")
    .select("*, client_links(*), users:bookkeeper_id(full_name)")
    .eq("id", rollbackJobId)
    .single();
  if (!rollbackJob) throw new Error("Rollback job not found");

  const clientLink = (rollbackJob as any).client_links;
  const bookkeeperName = (rollbackJob as any).users?.full_name || "Ironbooks";

  // Find all originally-executed reclassifications
  const { data: originalReclass } = await service
    .from("reclassifications")
    .select("*")
    .eq("reclass_job_id", originalJobId)
    .eq("status", "executed");

  if (!originalReclass || originalReclass.length === 0) {
    await service
      .from("reclass_jobs")
      .update({
        status: "complete",
        execution_completed_at: new Date().toISOString(),
        transactions_moved: 0,
        error_message: "No executed reclassifications found to roll back",
      } as any)
      .eq("id", rollbackJobId);
    return;
  }

  const accessToken = await getValidToken(clientLink.id, service as any);
  const auditMemo = buildAuditMemo(
    bookkeeperName,
    `ROLLBACK of reclass ${originalJobId}`
  );

  // Group by transaction
  const txMap = new Map<
    string,
    {
      tx_type: SupportedTxType;
      tx_id: string;
      lines: Array<{ line_id: string; new_account_id: string; new_account_name: string }>;
      original_reclass_row_ids: string[];
    }
  >();

  for (const r of originalReclass) {
    const key = `${r.qbo_transaction_type}::${r.qbo_transaction_id}`;
    let entry = txMap.get(key);
    if (!entry) {
      entry = {
        tx_type: r.qbo_transaction_type as SupportedTxType,
        tx_id: r.qbo_transaction_id,
        lines: [],
        original_reclass_row_ids: [],
      };
      txMap.set(key, entry);
    }
    // Inverse: move back to from_account
    entry.lines.push({
      line_id: r.line_id || "",
      new_account_id: r.from_account_id,
      new_account_name: r.from_account_name || "",
    });
    entry.original_reclass_row_ids.push(r.id);

    // Also create inverse reclassification rows for audit
    await service.from("reclassifications").insert({
      job_id: rollbackJobId,
      reclass_job_id: rollbackJobId,
      qbo_transaction_id: r.qbo_transaction_id,
      qbo_transaction_type: r.qbo_transaction_type,
      line_id: r.line_id,
      from_account_id: r.to_account_id,
      from_account_name: r.to_account_name,
      to_account_id: r.from_account_id,
      to_account_name: r.from_account_name,
      transaction_amount: r.transaction_amount,
      transaction_date: r.transaction_date,
      description: r.description,
      vendor_name: r.vendor_name,
      decision: "auto_approve",
      ai_reasoning: `Rollback to original account`,
      status: "pending",
    } as any);
  }

  let moved = 0;
  let failed = 0;
  const errors: string[] = [];

  const txList = Array.from(txMap.values());
  for (let i = 0; i < txList.length; i++) {
    const t = txList[i];

    if (i % 10 === 0) {
      await service.from("audit_log").insert({
        event_type: "reclass_progress",
        user_id: initiatingUserId,
        request_payload: {
          reclass_job_id: rollbackJobId,
          message: `Rolling back ${i + 1} of ${txList.length} transactions`,
          total: txList.length,
          completed: i,
        } as any,
      });
    }

    try {
      await reclassifyTransactionLines(clientLink.qbo_realm_id, accessToken, {
        txType: t.tx_type,
        txId: t.tx_id,
        lineUpdates: t.lines,
        auditMemo,
      });
      moved += t.lines.length;
    } catch (err: any) {
      failed += t.lines.length;
      errors.push(`${t.tx_type}/${t.tx_id}: ${err.message}`);
    }
  }

  const durationSec = Math.floor((Date.now() - startTime) / 1000);

  // Mark original job as rolled back
  await service
    .from("reclass_jobs")
    .update({
      rolled_back: true,
      rolled_back_at: new Date().toISOString(),
      rolled_back_by: initiatingUserId,
    } as any)
    .eq("id", originalJobId);

  // Complete rollback job
  await service
    .from("reclass_jobs")
    .update({
      status: "complete",
      execution_completed_at: new Date().toISOString(),
      execution_duration_seconds: durationSec,
      transactions_moved: moved,
      transactions_failed: failed,
      error_message: errors.length > 0 ? errors.slice(0, 10).join("; ") : null,
    } as any)
    .eq("id", rollbackJobId);

  await service.from("audit_log").insert({
    event_type: "reclass_job_complete",
    user_id: initiatingUserId,
    request_payload: {
      reclass_job_id: rollbackJobId,
      message: `Rollback complete: ${moved} moved back, ${failed} failed`,
      moved,
      failed,
      duration_seconds: durationSec,
      original_job_id: originalJobId,
    } as any,
  });
}

export const maxDuration = 300;
