import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/flagged/resolve
 *
 * Senior-bookkeeper resolution endpoint for items flagged during any workflow step.
 * Records the override + writes a full audit_log entry capturing both the
 * original AI suggestion AND the senior's decision for traceability.
 *
 * Access: admin + lead only. Bookkeepers are 403'd.
 *
 * Body:
 *  {
 *    source: "coa" | "reclass" | "stripe",
 *    item_id: string,
 *    decision: "approve" | "override" | "reject",
 *    override_target?: string,   // for COA: new account name; for reclass: new target_account_id
 *    notes?: string
 *  }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Role check — only admin + lead can resolve
  const { data: profile } = await supabase
    .from("users")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "lead"].includes(profile.role)) {
    return NextResponse.json(
      { error: "Forbidden — senior bookkeeper / admin role required" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const { source, item_id, decision, override_target, notes } = body;

  if (!["coa", "reclass", "stripe"].includes(source)) {
    return NextResponse.json({ error: "Invalid source" }, { status: 400 });
  }
  if (!["approve", "override", "reject"].includes(decision)) {
    return NextResponse.json({ error: "Invalid decision" }, { status: 400 });
  }
  if (!item_id) {
    return NextResponse.json({ error: "item_id required" }, { status: 400 });
  }

  const service = createServiceSupabase();

  // ─────────── COA ───────────
  if (source === "coa") {
    const { data: original } = await service
      .from("coa_actions")
      .select("*")
      .eq("id", item_id)
      .single();
    if (!original) return NextResponse.json({ error: "Not found" }, { status: 404 });

    let newAction: "keep" | "rename" | "delete" | "flag" = original.action as any;
    let newName: string | null = original.new_name;

    if (decision === "approve") {
      // Approve = use AI's suggested action/target if any, else keep
      newAction = (original.ai_suggested_target ? "rename" : "keep") as any;
      newName = original.ai_suggested_target || null;
    } else if (decision === "override") {
      newAction = "rename";
      newName = override_target || null;
    } else if (decision === "reject") {
      newAction = "keep";
      newName = null;
    }

    const { error: updErr } = await service
      .from("coa_actions")
      .update({
        action: newAction,
        new_name: newName,
        ai_suggested_target: newName || original.ai_suggested_target,
        bookkeeper_override: true,
        flagged_reason: null,
      } as any)
      .eq("id", item_id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    await writeAudit(service, {
      job_id: original.job_id,
      action_id: original.id,
      user_id: user.id,
      event_type: "flag_resolved_coa",
      request_payload: {
        message: `Senior ${profile.full_name} resolved COA flag: ${original.current_name}`,
        source: "coa",
        decision,
        original_ai_action: original.action,
        original_ai_reasoning: original.ai_reasoning,
        original_flagged_reason: original.flagged_reason,
      } as any,
      response_payload: {
        new_action: newAction,
        new_name: newName,
        notes: notes || null,
      } as any,
    });

    return NextResponse.json({ success: true });
  }

  // ─────────── RECLASS ───────────
  if (source === "reclass") {
    const { data: original } = await service
      .from("reclassifications")
      .select("*")
      .eq("id", item_id)
      .single();
    if (!original) return NextResponse.json({ error: "Not found" }, { status: 404 });

    let newDecision: string;
    let toAcctId: string = (original as any).to_account_id || "";
    let toAcctName: string = (original as any).to_account_name || "";

    if (decision === "approve") {
      newDecision = "auto_approve";
    } else if (decision === "override") {
      newDecision = "auto_approve";
      // override_target is the new target_account_id
      if (override_target) toAcctId = override_target;
    } else {
      newDecision = "rejected";
    }

    const { error: updErr } = await service
      .from("reclassifications")
      .update({
        decision: newDecision,
        to_account_id: toAcctId,
        to_account_name: toAcctName,
        bookkeeper_override: true,
      } as any)
      .eq("id", item_id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    await writeAudit(service, {
      job_id: (original as any).reclass_job_id || (original as any).job_id,
      user_id: user.id,
      event_type: "flag_resolved_reclass",
      request_payload: {
        message: `Senior ${profile.full_name} resolved reclass flag: ${(original as any).vendor_name}`,
        source: "reclass",
        decision,
        original_ai_decision: (original as any).decision,
        original_ai_reasoning: (original as any).ai_reasoning,
        vendor: (original as any).vendor_name,
        amount: (original as any).transaction_amount,
      } as any,
      response_payload: {
        new_decision: newDecision,
        new_target: toAcctName,
        notes: notes || null,
      } as any,
    });

    return NextResponse.json({ success: true });
  }

  // ─────────── STRIPE ───────────
  if (source === "stripe") {
    const { data: original } = await service
      .from("stripe_recon_matches")
      .select("*")
      .eq("id", item_id)
      .single();
    if (!original) return NextResponse.json({ error: "Not found" }, { status: 404 });

    let newDecision: "auto_approve" | "needs_review" | "flagged" =
      decision === "approve" || decision === "override" ? "auto_approve" : "flagged";

    const { error: updErr } = await service
      .from("stripe_recon_matches")
      .update({
        decision: newDecision,
        bookkeeper_override: true,
      } as any)
      .eq("id", item_id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

    await writeAudit(service, {
      job_id: (original as any).job_id,
      user_id: user.id,
      event_type: "flag_resolved_stripe",
      request_payload: {
        message: `Senior ${profile.full_name} resolved Stripe match flag: ${(original as any).qbo_deposit_id}`,
        source: "stripe",
        decision,
        original_ai_decision: (original as any).decision,
        original_ai_reasoning: (original as any).ai_reasoning,
        deposit_amount: (original as any).deposit_amount,
      } as any,
      response_payload: {
        new_decision: newDecision,
        notes: notes || null,
      } as any,
    });

    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Unhandled source" }, { status: 400 });
}

async function writeAudit(
  service: ReturnType<typeof createServiceSupabase>,
  entry: any
) {
  try {
    await service.from("audit_log").insert(entry);
  } catch (err: any) {
    console.error("[flagged/resolve] audit insert failed:", err.message);
  }
}
