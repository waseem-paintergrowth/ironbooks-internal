import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";
import { deliverPackage } from "@/lib/month-end";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/clients/[id]/month-end/send  — admin/lead only.
 *
 * Step 2 of "Close & send statements". The bookkeeper has reviewed the summary
 * from /prepare and confirmed. This marks the package reviewed + ready, then
 * delivers it — publishing the statements to the client portal AND emailing
 * the client. Idempotent: a package already sent returns its sent state.
 *
 * Body: { package_id }
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Senior access required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const packageId = body.package_id as string;
  if (!packageId) return NextResponse.json({ error: "package_id required" }, { status: 400 });

  // Validate the package belongs to this client (no cross-client sends).
  const { data: pkg } = await service
    .from("month_end_packages")
    .select("id, client_link_id, status")
    .eq("id", packageId)
    .single();
  if (!pkg || (pkg as any).client_link_id !== id) {
    return NextResponse.json({ error: "Package not found for this client" }, { status: 400 });
  }
  if ((pkg as any).status === "sent") {
    return NextResponse.json({ ok: true, alreadySent: true });
  }

  // Approve = the bookkeeper reviewed the summary in the UI and confirmed.
  // Mark reviewed + ready_to_send so deliverPackage's claim accepts it.
  await service
    .from("month_end_packages")
    .update({ status: "ready_to_send", ai_summary_reviewed: true, updated_at: new Date().toISOString() } as any)
    .eq("id", packageId)
    .neq("status", "sent");

  const appBaseUrl = new URL(request.url).origin;
  const result = await deliverPackage(service as any, packageId, user.id, appBaseUrl);

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error || "Send failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, result });
}
