import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/uncat-income/[scanId]/resolve
 *
 * Body: {
 *   item_ids: string[],
 *   resolution: 'apply_to_invoice' | 'customer_deposits' | 'ask_client' |
 *               'write_off' | 'move_to_revenue' | 'manual_investigation' | 'pending',
 *   target_invoice_qbo_id?: string,
 *   target_account_qbo_id?: string,
 *   target_account_name?: string,
 *   target_customer_qbo_id?: string,
 *   target_customer_name?: string,
 *   resolution_notes?: string,
 * }
 *
 * Bulk-update resolution for a list of items. Used by:
 *   - Single-row resolution picker
 *   - "Accept all auto-approve" banner button
 *   - "Add selected to ask-client email" bulk action
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; scanId: string }> }
) {
  const { id: clientLinkId, scanId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, assigned_bookkeeper_id")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { data: actor } = await service
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const isSenior = ["admin", "lead"].includes((actor as any)?.role || "");
  const isOwner = (client as any).assigned_bookkeeper_id === user.id;
  if (!isOwner && !isSenior) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const itemIds: string[] = Array.isArray(body.item_ids) ? body.item_ids : [];
  if (itemIds.length === 0) {
    return NextResponse.json({ error: "item_ids required" }, { status: 400 });
  }

  const allowedResolutions = new Set([
    "pending",
    "apply_to_invoice",
    "customer_deposits",
    "ask_client",
    "write_off",
    "move_to_revenue",
    "manual_investigation",
  ]);
  if (!allowedResolutions.has(body.resolution)) {
    return NextResponse.json(
      { error: `Invalid resolution: ${body.resolution}` },
      { status: 400 }
    );
  }

  // apply_to_invoice REQUIRES a target invoice
  if (body.resolution === "apply_to_invoice" && !body.target_invoice_qbo_id) {
    return NextResponse.json(
      { error: "apply_to_invoice requires target_invoice_qbo_id" },
      { status: 400 }
    );
  }
  // customer_deposits / write_off / move_to_revenue require a target account
  if (
    ["customer_deposits", "write_off", "move_to_revenue"].includes(body.resolution) &&
    !body.target_account_qbo_id
  ) {
    return NextResponse.json(
      { error: `${body.resolution} requires target_account_qbo_id` },
      { status: 400 }
    );
  }

  const updates: any = {
    resolution: body.resolution,
    target_invoice_qbo_id: body.target_invoice_qbo_id || null,
    target_account_qbo_id: body.target_account_qbo_id || null,
    target_account_name: body.target_account_name || null,
    target_customer_qbo_id: body.target_customer_qbo_id || null,
    target_customer_name: body.target_customer_name || null,
    resolution_notes: body.resolution_notes || null,
    resolved_by: body.resolution === "pending" ? null : user.id,
    resolved_at: body.resolution === "pending" ? null : new Date().toISOString(),
  };

  const { error: updErr, count } = await service
    .from("uncat_income_items" as any)
    .update(updates as any, { count: "exact" })
    .eq("scan_id", scanId)
    .in("id", itemIds);

  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, updated: count || 0 });
}
