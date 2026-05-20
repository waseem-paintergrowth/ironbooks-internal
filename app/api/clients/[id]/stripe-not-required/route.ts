import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * Mark / unmark a client as "doesn't use Stripe."
 *
 *   POST   { reason?: string }  → set stripe_not_required = true
 *   DELETE                      → clear back to false (re-enables
 *                                 every Stripe prompt for this client)
 *
 * Suppresses every Stripe-related nudge for the client:
 *   - The Pending Stripe Invites detector skips them
 *   - The dashboard widget filters them out
 *   - The comms-tracker Stripe row shows "Not applicable"
 *   - The Bank Rules → Stripe Recon handoff auto-skips
 *   - The Stripe Connect modal flags them visibly
 *
 * Audit-logged so we know who flipped each flag and why.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({} as any));
  const reason: string | undefined = body?.reason;

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name, stripe_connection_status, stripe_not_required")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // Safety: if Stripe is actually connected, flipping this on would
  // suppress prompts but leave a connected token. Warn (but allow).
  const wasConnected = (client as any).stripe_connection_status === "connected";

  await service
    .from("client_links")
    .update({
      stripe_not_required: true,
      stripe_not_required_at: new Date().toISOString(),
      stripe_not_required_by: user.id,
      stripe_not_required_reason: reason || null,
    } as any)
    .eq("id", clientLinkId);

  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "stripe_marked_not_required",
      request_payload: {
        client_link_id: clientLinkId,
        client_name: (client as any).client_name,
        reason: reason || null,
        was_connected: wasConnected,
      } as any,
    });
  } catch {
    // non-fatal
  }

  return NextResponse.json({
    ok: true,
    warning: wasConnected
      ? "Note: this client still has Stripe connected. The flag suppresses prompts; if you also want to disconnect, do it from the Stripe Connect Link modal."
      : undefined,
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  await service
    .from("client_links")
    .update({
      stripe_not_required: false,
      stripe_not_required_at: null,
      stripe_not_required_by: null,
      stripe_not_required_reason: null,
    } as any)
    .eq("id", clientLinkId);

  try {
    await service.from("audit_log").insert({
      user_id: user.id,
      event_type: "stripe_not_required_cleared",
      request_payload: { client_link_id: clientLinkId } as any,
    });
  } catch {
    // non-fatal
  }

  return NextResponse.json({ ok: true });
}
